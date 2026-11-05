/**
 * OSV as the CVE directory's source of truth. OSV decides which advisories
 * affect an installed version (its matching knows each ecosystem's version
 * rules), the public bucket serves full records, and each ecosystem's
 * `modified_id.csv` says what changed since the last sync. Only package names
 * and versions are ever sent; never code.
 */
import type { OsvRecord } from "./record";

const API = "https://api.osv.dev/v1";
const BUCKET = "https://osv-vulnerabilities.storage.googleapis.com";
const BATCH = 1_000;
/** Batches in flight at once: a large monorepo's inventory is several. */
const BATCH_CONCURRENCY = 4;
/** Bytes of a feed read per request; a ten-minute window is a few hundred bytes. */
const FEED_CHUNK = 256 * 1024;
/** A sync reads at most this much of one feed. Older changes are caught by the daily re-check. */
const FEED_MAX_BYTES = 4 * 1024 * 1024;

export interface PackageVersion {
  ecosystem: string;
  name: string;
  version: string;
}

export interface Change {
  id: string;
  /** When OSV last changed the record (RFC 3339, as OSV wrote it). */
  modified: string;
}

export interface OsvCatalog {
  /** The advisories affecting each package version, in input order. Withdrawn ones are never returned. */
  matches(packages: PackageVersion[], signal?: AbortSignal): Promise<Change[][]>;
  /** One full record: from the public bucket when the ecosystem is known, else the API. Undefined when OSV has none. */
  record(id: string, ecosystem?: string, signal?: AbortSignal): Promise<OsvRecord | undefined>;
  /** Records changed at or after `since` in one ecosystem's feed, newest first. `complete` is false when the read stopped at its cap. */
  changedSince(ecosystem: string, since: number, signal?: AbortSignal): Promise<{ changes: Change[]; complete: boolean }>;
}

export function createOsvCatalog(options: { fetch?: typeof fetch; timeoutMs?: number } = {}): OsvCatalog {
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const signalFor = (signal?: AbortSignal) => (signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs));

  async function json<T>(url: string, init: RequestInit, signal?: AbortSignal): Promise<T> {
    const response = await fetchImpl(url, { ...init, signal: signalFor(signal) });
    if (!response.ok) throw new Error(`OSV returned ${response.status} for ${new URL(url).pathname}`);
    return (await response.json()) as T;
  }

  type Page = { vulns?: Change[]; next_page_token?: string };

  /** The rest of one package's matches, when a batch result was cut short. */
  async function remaining(pkg: PackageVersion, token: string, signal?: AbortSignal): Promise<Change[]> {
    const out: Change[] = [];
    for (let pageToken: string | undefined = token; pageToken; ) {
      const page: Page = await json<Page>(`${API}/query`, post({ package: { ecosystem: pkg.ecosystem, name: pkg.name }, version: pkg.version, page_token: pageToken }), signal);
      out.push(...(page.vulns ?? []).map(({ id, modified }) => ({ id, modified })));
      pageToken = page.next_page_token;
    }
    return out;
  }

  return {
    async matches(packages, signal) {
      const chunks: PackageVersion[][] = [];
      for (let start = 0; start < packages.length; start += BATCH) chunks.push(packages.slice(start, start + BATCH));
      const answered = await mapLimit(chunks, BATCH_CONCURRENCY, async (chunk) => {
        const queries = chunk.map((p) => ({ package: { ecosystem: p.ecosystem, name: p.name }, version: p.version }));
        const { results } = await json<{ results: Page[] }>(`${API}/querybatch`, post({ queries }), signal);
        if (results.length !== chunk.length) throw new Error(`OSV answered ${results.length} of ${chunk.length} queries`);
        return Promise.all(
          results.map(async (result, i) => {
            const first = (result.vulns ?? []).map(({ id, modified }) => ({ id, modified }));
            return result.next_page_token ? [...first, ...(await remaining(chunk[i]!, result.next_page_token, signal))] : first;
          }),
        );
      });
      return answered.flat();
    },

    async record(id, ecosystem, signal) {
      const urls = ecosystem ? [`${BUCKET}/${encodeURIComponent(ecosystem)}/${encodeURIComponent(id)}.json`, `${API}/vulns/${encodeURIComponent(id)}`] : [`${API}/vulns/${encodeURIComponent(id)}`];
      for (const url of urls) {
        const response = await fetchImpl(url, { signal: signalFor(signal) });
        if (response.ok) return (await response.json()) as OsvRecord;
        if (response.status !== 404) throw new Error(`OSV returned ${response.status} for ${id}`);
      }
      return undefined;
    },

    async changedSince(ecosystem, since, signal) {
      const url = `${BUCKET}/${encodeURIComponent(ecosystem)}/modified_id.csv`;
      const changes: Change[] = [];
      let carry = "";
      for (let offset = 0; offset < FEED_MAX_BYTES; offset += FEED_CHUNK) {
        const response = await fetchImpl(url, { headers: { range: `bytes=${offset}-${offset + FEED_CHUNK - 1}` }, signal: signalFor(signal) });
        // Past the end of the file: everything has been read.
        if (response.status === 416) return { changes, complete: true };
        if (!response.ok) throw new Error(`OSV feed returned ${response.status} for ${ecosystem}`);
        const text = carry + (await response.text());
        // A server that ignores Range sends the whole file at once.
        const whole = response.status === 200;
        const end = whole ? text.length : text.lastIndexOf("\n") + 1;
        for (const line of text.slice(0, end).split("\n")) {
          const comma = line.indexOf(",");
          if (comma < 0) continue;
          const modified = line.slice(0, comma).trim();
          const at = stampMs(modified);
          if (at === null) continue;
          // Newest first: the first line older than `since` ends the window.
          if (at < since) return { changes, complete: true };
          changes.push({ id: line.slice(comma + 1).trim(), modified });
        }
        if (whole) return { changes, complete: true };
        carry = text.slice(end);
        const range = response.headers.get("content-range");
        const total = range ? Number(range.split("/")[1]) : Number.NaN;
        if (Number.isFinite(total) && offset + FEED_CHUNK >= total) return { changes, complete: true };
      }
      return { changes, complete: false };
    },
  };
}

function post(body: unknown): RequestInit {
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

/**
 * Milliseconds since the epoch for an OSV timestamp. OSV writes up to nine
 * fractional digits, which `Date.parse` doesn't promise to read.
 */
export function stampMs(stamp: string): number | null {
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)$/.exec(stamp.trim());
  if (!match) return null;
  const ms = Date.parse(`${match[1]}.${(match[2] ?? "").padEnd(3, "0").slice(0, 3)}${match[3]}`);
  return Number.isNaN(ms) ? null : ms;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]!);
      }
    }),
  );
  return results;
}

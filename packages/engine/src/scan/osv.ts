/**
 * Known vulnerabilities from OSV (osv.dev). Only package names and versions
 * are sent; never code.
 */

const API = "https://api.osv.dev/v1";
const BATCH = 1_000;
const DETAIL_CONCURRENCY = 16;

export interface PackageRef {
  ecosystem: string;
  name: string;
  version: string;
}

export interface Advisory {
  id: string;
  aliases: string[];
  summary: string;
  severity: "critical" | "high" | "medium" | "low" | "unknown";
  /** First fixed version for this package, if any. */
  fixed?: string;
}

export interface OsvClient {
  /** Advisories per package, in input order. */
  query(packages: PackageRef[], signal?: AbortSignal): Promise<Advisory[][]>;
}

interface OsvVuln {
  id: string;
  aliases?: string[];
  summary?: string;
  details?: string;
  database_specific?: { severity?: string };
  affected?: Array<{ package?: { name?: string; ecosystem?: string }; ranges?: Array<{ events?: Array<{ introduced?: string; fixed?: string }> }> }>;
}

export function createOsvClient(options: { fetch?: typeof fetch; timeoutMs?: number } = {}): OsvClient {
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 20_000;
  // Advisory details never change within a process lifetime worth caring about.
  const details = new Map<string, Promise<OsvVuln | undefined>>();

  async function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const response = await fetchImpl(`${API}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) throw new Error(`OSV returned ${response.status}`);
    return (await response.json()) as T;
  }

  function detail(id: string, signal?: AbortSignal): Promise<OsvVuln | undefined> {
    let pending = details.get(id);
    if (!pending) {
      const timeout = AbortSignal.timeout(timeoutMs);
      pending = fetchImpl(`${API}/vulns/${encodeURIComponent(id)}`, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
        .then((response) => (response.ok ? (response.json() as Promise<OsvVuln>) : undefined))
        .catch(() => {
          details.delete(id);
          return undefined;
        });
      details.set(id, pending);
    }
    return pending;
  }

  return {
    async query(packages, signal) {
      const ids: string[][] = [];
      for (let start = 0; start < packages.length; start += BATCH) {
        const queries = packages.slice(start, start + BATCH).map((p) => ({ package: { ecosystem: p.ecosystem, name: p.name }, version: p.version }));
        const result = await post<{ results: Array<{ vulns?: Array<{ id: string }> }> }>("/querybatch", { queries }, signal);
        ids.push(...result.results.map((r) => (r.vulns ?? []).map((v) => v.id)));
      }

      const unique = [...new Set(ids.flat())];
      await mapLimit(unique, DETAIL_CONCURRENCY, (id) => detail(id, signal));

      return Promise.all(
        packages.map(async (pkg, i) => {
          const advisories = await Promise.all((ids[i] ?? []).map((id) => detail(id, signal)));
          return advisories.filter((v): v is OsvVuln => v !== undefined).map((v) => toAdvisory(v, pkg));
        }),
      );
    },
  };
}

function toAdvisory(vuln: OsvVuln, pkg: PackageRef): Advisory {
  const affected = vuln.affected?.find((a) => a.package?.name === pkg.name) ?? vuln.affected?.[0];
  const fixed = fixedVersionFor(affected?.ranges?.flatMap((r) => r.events ?? []) ?? [], pkg.version);
  const summary = (vuln.summary || vuln.details || "").split("\n")[0]!.slice(0, 200);
  return { id: vuln.id, aliases: vuln.aliases ?? [], summary, severity: severityOf(vuln), fixed };
}

/**
 * The fix for the release line the installed version is on. Advisories list
 * one range per line (e.g. 15.x fixed in 15.5.28, 16.x in 16.3.8); suggesting
 * another line's fix is wrong.
 */
export function fixedVersionFor(events: Array<{ introduced?: string; fixed?: string }>, installed: string): string | undefined {
  let introduced: string | undefined;
  let fallback: string | undefined;
  for (const event of events) {
    if (event.introduced !== undefined) introduced = event.introduced;
    if (event.fixed === undefined) continue;
    fallback ??= event.fixed;
    const inRange = (introduced === undefined || compareVersions(installed, introduced) >= 0) && compareVersions(installed, event.fixed) < 0;
    if (inRange) return event.fixed;
  }
  return fallback;
}

/** Compares dotted numeric versions, ignoring pre-release suffixes. Good enough to pick a range. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.replace(/^v/, "").split(/[.+-]/).map((p) => Number.parseInt(p, 10)).map((n) => (Number.isNaN(n) ? 0 : n));
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function severityOf(vuln: OsvVuln): Advisory["severity"] {
  switch (vuln.database_specific?.severity?.toUpperCase()) {
    case "CRITICAL":
      return "critical";
    case "HIGH":
      return "high";
    case "MODERATE":
    case "MEDIUM":
      return "medium";
    case "LOW":
      return "low";
    default:
      return "unknown";
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return results;
}

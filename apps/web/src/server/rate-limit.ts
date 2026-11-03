/**
 * Per-address limits for the endpoints anyone may call without an account.
 * Counted in this server instance's memory only, so addresses are never
 * stored or logged. With many instances one address gets somewhat more than
 * a limit; callers that add rows also keep an overall ceiling in the database.
 */

/** Addresses remembered at once: past this the oldest are forgotten first. */
const MAX_KEYS = 10_000;

const windows = new Map<string, { until: number; count: number }>();
const open = new Map<string, number>();

/**
 * The caller's address as the proxy in front reports it. The last hop is the
 * one that proxy added (Vercel sends only that one); earlier hops are the
 * caller's to write. IPv6 counts by /64, which one host usually has whole.
 */
export function clientAddress(request: Request): string {
  const ip = request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() || "unknown";
  const v4 = /\d{1,3}(\.\d{1,3}){3}/.exec(ip);
  if (v4) return v4[0];
  if (!ip.includes(":")) return ip;
  const [head = "", tail] = ip.replace(/^\[|\]$/g, "").split("%")[0]!.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = tail === undefined ? left : [...left, ...Array<string>(Math.max(8 - left.length - right.length, 0)).fill("0"), ...right];
  return `${groups
    .slice(0, 4)
    .map((group) => group.toLowerCase().replace(/^0+(?=.)/, ""))
    .join(":")}::/64`;
}

/** Counts one call for `key` and says whether it is within `limit` per `windowMs`. */
export function admit(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
  let entry = windows.get(key);
  if (!entry || entry.until <= now) {
    windows.delete(key);
    if (windows.size >= MAX_KEYS) {
      for (const [seen, { until }] of windows) if (until <= now) windows.delete(seen);
      for (const seen of windows.keys()) {
        if (windows.size < MAX_KEYS) break;
        windows.delete(seen);
      }
    }
    entry = { until: now + windowMs, count: 0 };
    windows.set(key, entry);
  }
  entry.count++;
  return entry.count <= limit;
}

/** Takes one of `limit` slots `key` may hold at once, or undefined when all are taken. Call what it returns to give it back. */
export function hold(key: string, limit: number): (() => void) | undefined {
  const held = open.get(key) ?? 0;
  if (held >= limit) return undefined;
  open.set(key, held + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (open.get(key) ?? 1) - 1;
    if (left > 0) open.set(key, left);
    else open.delete(key);
  };
}

/** For tests. */
export function resetLimits(): void {
  windows.clear();
  open.clear();
}

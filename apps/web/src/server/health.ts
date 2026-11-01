/**
 * The health check behind /api/health: settings usable (see readiness) and
 * the database answering, in setup mode too. Its own one-connection client
 * reads DATABASE_URL directly, since before setup there is no full
 * configuration, and gives up after two seconds. The answer is reused for
 * two seconds, and concurrent checks share one query, so unauthenticated
 * health requests cannot hammer the database.
 */
import { createDb, type Db } from "@sandchest/db";
import { configurationProblem } from "./readiness";

const CACHE_MS = 2_000;
const TIMEOUT_MS = 2_000;

type Env = Record<string, string | undefined>;

let probe: { url: string; db: Db } | undefined;
let last: { at: number; ok: boolean } | undefined;
let pending: Promise<boolean> | undefined;

export function healthy(env: Env = process.env): Promise<boolean> {
  if (last && Date.now() - last.at < CACHE_MS) return Promise.resolve(last.ok);
  pending ??= check(env)
    .then((ok) => {
      last = { at: Date.now(), ok };
      return ok;
    })
    .finally(() => (pending = undefined));
  return pending;
}

/** For tests. */
export function resetHealth(): void {
  last = undefined;
}

async function check(env: Env): Promise<boolean> {
  if (configurationProblem(env)) return false;
  const url = env.DATABASE_URL?.trim();
  if (!url) return false;
  if (probe?.url !== url) {
    void probe?.db.$client.end({ timeout: 1 }).catch(() => {});
    probe = { url, db: createDb(url, { max: 1, connectTimeout: TIMEOUT_MS / 1000 }) };
  }
  const client = probe.db.$client;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), TIMEOUT_MS)));
  try {
    return await Promise.race([client`select 1`.then(() => true as const), timeout]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

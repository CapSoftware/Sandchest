/**
 * Dynamic validation: boot the app in the disposable workspace and reproduce
 * the attack a finding describes, so a developer sees proof — "we did this" —
 * not just an argument. A finding that reproduces becomes `verified`.
 *
 * The one invariant that makes this safe to ship: validation is asymmetric. A
 * reproduction can only *add* the `verified` badge. It never lowers a
 * finding's confidence and never drops it, so a repo that will not boot, a
 * control that fails, or an attack that simply does not fire all leave the
 * finding exactly as the skeptic left it (`inconclusive`). This mirrors the
 * skeptic's own rule — a finding may only be dropped by citing the code that
 * blocks it — and it is what protects recall from a flaky bring-up.
 *
 * Everything runs on the workspace's own loopback: the app listens on
 * 127.0.0.1 and every probe curls that address, so attack traffic never leaves
 * the microVM. Teardown is the workspace's job (`destroy()` kills the process
 * group), so nothing here needs to stop the server it starts.
 */
import type { Runtime } from "./runtime";
import type { Finding, Validation } from "./schema";

/** Where the app is reached, and how we recognised how to start it. */
export interface BringUpPlan {
  strategy: "node-npm" | "node-yarn" | "node-pnpm";
  /** Install dependencies first. Omitted when nothing needs installing. */
  install?: string[];
  /** The long-running command that starts the server. Invoked, not its text, so a hostile script body cannot inject. */
  start: string[];
  /** Port the app is told to listen on and that readiness is polled against. */
  port: number;
  /** A path that answers once the app is up, e.g. `/`. */
  readinessPath: string;
  /** Extra environment for install and start. */
  env: Record<string, string>;
}

/** Reads repo files for detection. `Runtime` provides one; tests pass their own. */
export interface RepoProbe {
  read(path: string): Promise<string | null>;
}

export function repoProbe(runtime: Runtime): RepoProbe {
  return {
    read: (path) => runtime.readFile(path).then((c) => c, () => null),
  };
}

const DEFAULT_PORT = 3000;

/**
 * Works out how to boot the app, or why we cannot yet. The ladder is
 * deliberately shallow for now (Node package managers); Dockerfile, compose
 * and Procfile apps are recognised and explicitly declined rather than booted
 * wrongly. Returning a reason, not throwing, keeps an unbootable repo a
 * non-event: the finding stays `inconclusive`.
 */
export async function planBringUp(probe: RepoProbe): Promise<BringUpPlan | { unsupported: string }> {
  const packageJson = await probe.read("package.json");
  if (!packageJson) {
    const other = await firstPresent(probe, ["docker-compose.yml", "compose.yaml", "Dockerfile", "Procfile"]);
    if (other) return { unsupported: `${other} bring-up is not implemented yet` };
    return { unsupported: "no recognised way to start this app" };
  }

  let scripts: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(packageJson) as { scripts?: Record<string, unknown> };
    scripts = parsed.scripts ?? {};
  } catch {
    return { unsupported: "package.json is not valid JSON" };
  }
  const script = typeof scripts.start === "string" ? "start" : typeof scripts.dev === "string" ? "dev" : null;
  if (!script) return { unsupported: "package.json has no start or dev script" };

  const [pnpm, yarn, npm] = await Promise.all([
    firstPresent(probe, ["pnpm-lock.yaml"]),
    firstPresent(probe, ["yarn.lock"]),
    firstPresent(probe, ["package-lock.json", "npm-shrinkwrap.json"]),
  ]);
  const strategy = pnpm ? "node-pnpm" : yarn ? "node-yarn" : "node-npm";
  const install =
    strategy === "node-pnpm"
      ? ["pnpm", "install", "--frozen-lockfile"]
      : strategy === "node-yarn"
        ? ["yarn", "install", "--frozen-lockfile"]
        : npm
          ? ["npm", "ci"]
          : ["npm", "install"];
  const run =
    strategy === "node-pnpm" ? ["pnpm", "run", script] : strategy === "node-yarn" ? ["yarn", script] : ["npm", "run", script];

  return {
    strategy,
    install,
    start: run,
    port: DEFAULT_PORT,
    readinessPath: "/",
    env: { PORT: String(DEFAULT_PORT), HOST: "127.0.0.1", CI: "1" },
  };
}

async function firstPresent(probe: RepoProbe, paths: string[]): Promise<string | null> {
  for (const path of paths) if ((await probe.read(path)) !== null) return path;
  return null;
}

export type BootResult = { ready: true; baseUrl: string } | { ready: false; reason: string };

export interface BringUpOptions {
  /** Absolute wall-clock deadline (ms epoch) for install + start + readiness. */
  deadline: number;
  /** Cap on dependency install alone. Default 8 min; large apps (frontend builds) need more. */
  installTimeoutMs?: number;
  signal?: AbortSignal;
  /** Progress lines for the live feed. Never code or secrets. */
  onProgress?: (message: string) => void;
}

const DEFAULT_INSTALL_TIMEOUT_MS = 8 * 60_000;

/** Installs, starts the server detached, and waits for it to answer. */
export async function bringUp(runtime: Runtime, plan: BringUpPlan, options: BringUpOptions): Promise<BootResult> {
  const { deadline, signal } = options;
  const remaining = () => deadline - Date.now();
  if (plan.install) {
    options.onProgress?.("Installing dependencies to boot the app…");
    const install = await runtime.exec(plan.install, { timeoutMs: Math.min(remaining(), options.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS), env: plan.env, signal });
    if (install.exitCode !== 0) return { ready: false, reason: install.timedOut ? "dependency install timed out" : "dependency install failed" };
  }
  if (remaining() <= 0) return { ready: false, reason: "ran out of time before the app could start" };

  options.onProgress?.("Starting the app…");
  // The server must outlive this call and be killed by workspace teardown, not
  // leak. `startDetached` does exactly that; without it, a fire-and-forget
  // `exec` keeps the process tracked on the local runtime to the same effect.
  let earlyExit: string | undefined;
  if (runtime.startDetached) {
    try {
      await runtime.startDetached(plan.start, { env: plan.env });
    } catch (error) {
      return { ready: false, reason: `the start command could not be launched: ${(error as Error).message}` };
    }
  } else {
    void Promise.resolve(runtime.exec(plan.start, { env: plan.env, signal })).then(
      (result) => {
        earlyExit = result.timedOut ? "the start command timed out" : `the start command exited (code ${result.exitCode}) before the app was ready`;
      },
      (error) => {
        earlyExit = `the start command could not be launched: ${(error as Error).message}`;
      },
    );
  }

  const baseUrl = `http://127.0.0.1:${plan.port}`;
  const ready = await waitForHttp(runtime, baseUrl + plan.readinessPath, deadline, signal, () => earlyExit);
  if (earlyExit) return { ready: false, reason: earlyExit };
  if (!ready) return { ready: false, reason: `the app did not answer on port ${plan.port} in time` };
  options.onProgress?.("App is up; reproducing the attack…");
  return { ready: true, baseUrl };
}

/** Polls until the URL returns any HTTP status (the port is listening), the deadline passes, or the server exits. */
async function waitForHttp(runtime: Runtime, url: string, deadline: number, signal: AbortSignal | undefined, stopped: () => string | undefined): Promise<boolean> {
  while (Date.now() < deadline) {
    if (signal?.aborted || stopped()) return false;
    const status = await httpStatus(runtime, url, signal);
    if (status > 0) return true;
    await sleep(500, signal);
  }
  return false;
}

async function httpStatus(runtime: Runtime, url: string, signal?: AbortSignal): Promise<number> {
  const result = await runtime.exec(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "3", url], {
    timeoutMs: 5_000,
    signal,
  });
  return result.exitCode === 0 ? Number(result.stdout.trim()) || 0 : 0;
}

// --- Two-tenant access-control oracle -------------------------------------

/**
 * A reproduction recipe for a cross-tenant (IDOR / broken access control)
 * finding. Each step is one request; a step may capture values from its JSON
 * response for later steps to use via `${var}`. The recipe is produced by a
 * trusted step (a benchmark fixture now, model-generated and validated later),
 * never taken raw from repository content.
 *
 * The flow a recipe encodes:
 *   - stand up a *victim* who owns a resource holding a unique marker,
 *   - stand up an *attacker* with only their own credentials,
 *   - `victimRead`  : the victim reads their own resource (control — proves the marker and route work),
 *   - `attackerRead`: the attacker reads the victim's resource (the attack),
 *   - `decoyRead`   : the attacker reads a resource that does not exist (control — proves the route does not echo any marker).
 */
export interface TwoTenantRecipe {
  marker: string;
  setup: RequestStep[];
  victimRead: RequestStep;
  attackerRead: RequestStep;
  decoyRead: RequestStep;
}

export interface RequestStep {
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** Appended to the base URL. May contain `${var}` from an earlier capture. */
  path: string;
  headers?: Record<string, string>;
  /** JSON request body; string values may contain `${var}`. */
  jsonBody?: unknown;
  /** Map of variable name → dot path into the JSON response to capture. */
  capture?: Record<string, string>;
}

interface ProbeObservation {
  victimSawOwnMarker: boolean;
  attackerSawVictimMarker: boolean;
  attackerSawDecoyMarker: boolean;
  error?: string;
}

/**
 * The verdict, as a pure function of what the probes observed. Both controls
 * must hold before a positive attack result counts, so a route that 404s
 * everything (victim control fails) or echoes any id (decoy control fails)
 * can never produce a false `verified`.
 */
export function judgeTwoTenant(obs: ProbeObservation): Validation {
  const method = "two-tenant";
  if (obs.error) return { status: "inconclusive", method, detail: `could not complete the probe: ${obs.error}` };
  if (!obs.victimSawOwnMarker) return { status: "inconclusive", method, detail: "control failed: the owner could not read their own resource, so the probe is unreliable" };
  if (obs.attackerSawDecoyMarker) return { status: "inconclusive", method, detail: "control failed: the endpoint returned the marker for a resource that does not exist" };
  if (obs.attackerSawVictimMarker) return { status: "verified", method, detail: "reproduced: a second tenant's credentials returned the victim's unique marker" };
  return { status: "inconclusive", method, detail: "the attack did not reproduce: the second tenant could not read the victim's resource" };
}

/** Runs a two-tenant recipe against a booted app and judges the result. */
export async function runTwoTenant(runtime: Runtime, baseUrl: string, recipe: TwoTenantRecipe, signal?: AbortSignal): Promise<Validation> {
  const vars = new Map<string, string>();
  try {
    for (const step of recipe.setup) await request(runtime, baseUrl, step, vars, signal);
    const victim = await request(runtime, baseUrl, recipe.victimRead, vars, signal);
    const attacker = await request(runtime, baseUrl, recipe.attackerRead, vars, signal);
    const decoy = await request(runtime, baseUrl, recipe.decoyRead, vars, signal);
    return judgeTwoTenant({
      victimSawOwnMarker: victim.includes(recipe.marker),
      attackerSawVictimMarker: attacker.includes(recipe.marker),
      attackerSawDecoyMarker: decoy.includes(recipe.marker),
    });
  } catch (error) {
    return judgeTwoTenant({ victimSawOwnMarker: false, attackerSawVictimMarker: false, attackerSawDecoyMarker: false, error: (error as Error).message });
  }
}

const STATUS_MARK = "<<<SANDCHEST_STATUS:";

/** One HTTP request via curl, with `${var}` substitution and JSON capture. Returns the response body. */
async function request(runtime: Runtime, baseUrl: string, step: RequestStep, vars: Map<string, string>, signal?: AbortSignal): Promise<string> {
  const sub = (s: string) => s.replace(/\$\{(\w+)\}/g, (_, name: string) => vars.get(name) ?? "");
  const argv = ["curl", "-s", "-X", step.method, "-w", `\n${STATUS_MARK}%{http_code}>>>`];
  for (const [key, value] of Object.entries(step.headers ?? {})) argv.push("-H", `${key}: ${sub(value)}`);
  if (step.jsonBody !== undefined) {
    argv.push("-H", "Content-Type: application/json", "-d", sub(JSON.stringify(step.jsonBody)));
  }
  argv.push(baseUrl + sub(step.path));
  const result = await runtime.exec(argv, { timeoutMs: 15_000, signal });
  if (result.exitCode !== 0) throw new Error(`request to ${step.path} failed`);
  const cut = result.stdout.lastIndexOf(`\n${STATUS_MARK}`);
  const body = cut >= 0 ? result.stdout.slice(0, cut) : result.stdout;
  if (step.capture) captureInto(vars, body, step.capture);
  return body;
}

function captureInto(vars: Map<string, string>, body: string, capture: Record<string, string>): void {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return;
  }
  for (const [name, path] of Object.entries(capture)) {
    const value = dotPath(json, path);
    if (value !== undefined && value !== null) vars.set(name, String(value));
  }
}

function dotPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => (acc != null && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined), value);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

// --- Stage ----------------------------------------------------------------

export interface ValidateOptions {
  /** Supplies a reproduction recipe for a finding, or null to skip it. Keeps app-specifics out of the engine. */
  recipeFor: (finding: Finding) => TwoTenantRecipe | null;
  /** Absolute wall-clock deadline (ms epoch) for the whole stage. */
  deadline: number;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

/**
 * The stronger, runtime tier: boots the app once and reproduces the findings
 * it has recipes for. It only ever *upgrades* a finding to `verified` — it
 * never overwrites a weaker result (e.g. a `path_confirmed` from the code-path
 * proof), so an unbootable repo or a probe that does not fire leaves the
 * finding exactly as it was.
 */
export async function validateFindings(runtime: Runtime, findings: Finding[], options: ValidateOptions): Promise<void> {
  const targets = findings.map((finding) => ({ finding, recipe: options.recipeFor(finding) })).filter((t): t is { finding: Finding; recipe: TwoTenantRecipe } => t.recipe !== null);
  if (targets.length === 0) return;

  const plan = await planBringUp(repoProbe(runtime));
  if ("unsupported" in plan) return;

  const boot = await bringUp(runtime, plan, { deadline: options.deadline, signal: options.signal, onProgress: options.onProgress });
  if (!boot.ready) return;

  for (const { finding, recipe } of targets) {
    if (options.signal?.aborted || Date.now() >= options.deadline) break;
    const result = await runTwoTenant(runtime, boot.baseUrl, recipe, options.signal);
    if (result.status === "verified") {
      finding.validation = result;
      options.onProgress?.(`Reproduced ${finding.title} live.`);
    }
  }
}

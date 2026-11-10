import { readFile } from "node:fs/promises";
import { constants } from "node:os";
import { posix } from "node:path";
import {
  WorkspaceError,
  type CloneOptions,
  type ExecOptions,
  type ExecResult,
  type IndexerBinary,
  type RepoRef,
  type Workspace,
} from "./index";
import { INDEXER_PORT, type IndexerHandle } from "./indexer";
import { BASE_ENV, cloneCommand, DEFAULT_CLONE_TIMEOUT_MS, resolveInside } from "./shared";

export { agentSandboxSetupScript, type AgentSandboxSetup } from "./boat-setup";
export { AGENT_RELAY_ENV, AGENT_RELAY_MAX_BODY, agentRelayCommand, agentRelayScript, type AgentRelaySettings } from "./agent-relay";
export { BULK_READ_LIMITS, bulkReadFiles, type BulkReadResult, type BulkReadSandbox } from "./bulk-read";

export const BOAT_API_URL = "https://boat.dev/api/v1";

/** Machine sizes: small 2 vCPU / 4 GB, default 4 / 8, large 8 / 16, xlarge (bigger plans only). */
export const BOAT_SIZES = ["small", "default", "large", "xlarge"] as const;
export type BoatSize = (typeof BOAT_SIZES)[number];

export type BoatState =
  | "init"
  | "provisioning"
  | "provisioned"
  | "cloning"
  | "ready"
  | "idle"
  | "running"
  | "archiving"
  | "archived"
  | "error"
  | "cancelled";

/** The fields of a sandbox this backend reads. The API sends more. */
export interface BoatSandbox {
  id: string;
  state: BoatState;
  error?: string | null;
  type?: BoatSize;
  labels?: Record<string, string>;
  archiveAfter?: string | null;
  ttlSeconds?: number | null;
  setupStatus?: "pending" | "running" | "done" | "failed" | null;
  setupError?: string | null;
}

/** Billable machine time of one sandbox, size multiplier applied, at list price. */
export interface BoatUsage {
  seconds: number;
  usd: number;
  /** The meter is still moving. Read again after the sandbox stops for the final figure. */
  running: boolean;
}

/** A detached command, as last reported by the sandbox. */
export interface BoatProcessStatus {
  /** `lost`: the sandbox's agent restarted and forgot the process (or the sandbox rebooted); treat it as ended. */
  state: "running" | "exited" | "lost";
  /** Exit status once ended; `128 + signal` if it was killed. Null while running. */
  exitCode: number | null;
  /** The last `tailBytes` of each log. */
  stdout: string;
  stderr: string;
}

/** A detached command in the sandbox. Holds only ids, so a later invocation can rebuild it with `BoatWorkspace.process()`. */
export interface BoatProcess {
  readonly sandboxId: string;
  readonly processId: number;
  status(options?: { tailBytes?: number }): Promise<BoatProcessStatus>;
  /** SIGTERM to the command and everything it started, SIGKILL 5 s later. Safe to call more than once or after it has ended. */
  stop(): Promise<void>;
}

export interface BoatClientOptions {
  apiKey: string;
  /** Default https://boat.dev/api/v1. */
  baseUrl?: string;
  /** Injectable for tests. Default the global `fetch`. */
  fetch?: typeof fetch;
  /** Per-request timeout. Default 30 s; blocking commands get their own timeout plus margin. */
  timeoutMs?: number;
  /** Extra attempts for retryable calls. Default 4. */
  retries?: number;
  /** First backoff step, doubled per attempt, plus jitter. Default 500 ms. */
  backoffMs?: number;
  /** Longest server-requested wait (`Retry-After`) worth honouring; anything longer fails at once. Default 30 s. */
  maxRetryDelayMs?: number;
  signal?: AbortSignal;
}

/**
 * How a failed call may be retried:
 * - `idempotent`: on network errors, 429 and 5xx (reads, file writes, deletes, TTL changes, creates with an idempotency key).
 * - `refused`: only when the API proves the request never ran (429, `sandbox_starting`, `sandbox_restoring`). Commands use it.
 * - `never`: a create without an idempotency key.
 */
type RetryPolicy = "idempotent" | "refused" | "never";

/** An error answer from the Boat API. The message never holds the API key or a signed URL. */
export class BoatApiError extends WorkspaceError {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | undefined,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

interface ErrorBody {
  code?: string;
  message?: string;
  retryAfterSeconds?: number;
  retryAfter?: number;
  error?: { code?: string; message?: string; details?: Record<string, unknown> };
}

const SANDBOX_ID = /^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/;
const LABEL_KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,62}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RUN_AS = /^[a-z_][a-z0-9_-]{0,31}$/;
const AGENT_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_TTL_SECONDS = 2_592_000;
/** The API's cap on a blocking command. */
const MAX_COMMAND_SECONDS = 600;
/** A command sent while the sandbox starts waits up to 60 s before it runs. */
const START_WAIT_MS = 60_000;
/** The API's limit on an inline file read or write, after decoding. */
export const BOAT_MAX_INLINE_FILE_BYTES = 5 * 1024 * 1024;
const SIGKILL_EXIT = 137;

const SANDBOX_HOME = "/home/user";
/** Holds per-command environment files. Mode 700, so another user in the sandbox (an agent) cannot read them. */
const PRIVATE_DIR = `${SANDBOX_HOME}/.sandchest`;

/** A small typed client for the parts of the Boat v1 API a workspace uses. */
export class BoatClient {
  private readonly baseUrl: string;
  private readonly fetch: typeof fetch;

  constructor(private readonly options: BoatClientOptions) {
    if (!options.apiKey) throw new WorkspaceError("A Boat API key is required");
    this.baseUrl = (options.baseUrl ?? BOAT_API_URL).replace(/\/$/, "");
    this.fetch = options.fetch ?? fetch;
  }

  /**
   * Creates a sandbox (202 while it provisions). Retried only with an idempotency
   * key: the key makes a retry return the same sandbox instead of billing a second.
   */
  async createSandbox(body: Record<string, unknown>, options: { idempotencyKey?: string } = {}): Promise<BoatSandbox> {
    const headers: Record<string, string> = options.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : {};
    const result = await this.request<{ sandbox: BoatSandbox }>("POST", "/sandboxes", {
      body,
      headers,
      retry: options.idempotencyKey ? "idempotent" : "never",
    });
    return result.sandbox;
  }

  async getSandbox(id: string): Promise<BoatSandbox> {
    return (await this.request<{ sandbox: BoatSandbox }>("GET", sandboxPath(id), { retry: "idempotent" })).sandbox;
  }

  /** Sets the auto-stop deadline to now + `ttlSeconds`. */
  async setTtl(id: string, ttlSeconds: number): Promise<BoatSandbox> {
    return (await this.request<{ sandbox: BoatSandbox }>("PATCH", sandboxPath(id), { body: { ttlSeconds }, retry: "idempotent" })).sandbox;
  }

  /** Accepts permanent deletion. Resolves `false` when the sandbox was already gone. */
  async deleteSandbox(id: string): Promise<boolean> {
    try {
      await this.request("DELETE", sandboxPath(id), { headers: { "x-ascii-confirm-delete": id }, retry: "idempotent" });
      return true;
    } catch (error) {
      if (error instanceof BoatApiError && error.status === 404) return false;
      throw error;
    }
  }

  /** Runs a shell command and waits for it, up to `timeoutSeconds` (1 to 600). Never retried once it may have run. */
  runCommand(id: string, command: string, timeoutSeconds: number): Promise<BoatCommandResult> {
    return this.request<BoatCommandResult>("POST", `${sandboxPath(id)}/commands`, {
      body: { command, timeoutSeconds },
      retry: "refused",
      timeoutMs: timeoutSeconds * 1000 + START_WAIT_MS + 30_000,
    });
  }

  /** Starts a shell command in the background and returns its process id at once. */
  async startCommand(id: string, command: string): Promise<{ processId: number }> {
    const started = await this.request<{ processId: number }>("POST", `${sandboxPath(id)}/commands`, {
      body: { command, detached: true },
      retry: "refused",
      timeoutMs: START_WAIT_MS + 30_000,
    });
    if (!Number.isInteger(started.processId)) throw new WorkspaceError("Boat did not return a process id");
    return { processId: started.processId };
  }

  commandStatus(id: string, processId: number, options: { tailBytes?: number } = {}): Promise<BoatCommandStatus> {
    return this.request<BoatCommandStatus>("GET", `${sandboxPath(id)}/commands/${processPath(processId)}`, {
      query: { tailBytes: String(options.tailBytes ?? 64 * 1024) },
      retry: "idempotent",
    });
  }

  /** Stops a detached command. A command that is already gone counts as stopped. */
  async stopCommand(id: string, processId: number): Promise<void> {
    try {
      await this.request("DELETE", `${sandboxPath(id)}/commands/${processPath(processId)}`, { retry: "idempotent" });
    } catch (error) {
      if (error instanceof BoatApiError && error.status === 404) return;
      throw error;
    }
  }

  /** Reads a file of up to 5 MiB under /home/user or /tmp. */
  readFile(id: string, path: string, encoding: "utf8" | "base64"): Promise<{ content: string; size: number }> {
    return this.request("GET", `${sandboxPath(id)}/files`, { query: { path, encoding }, retry: "idempotent" });
  }

  /** Writes a file of up to 5 MiB (after decoding) under /home/user or /tmp, creating missing folders. */
  async writeFile(id: string, path: string, content: string, encoding: "utf8" | "base64"): Promise<void> {
    await this.request("PUT", `${sandboxPath(id)}/files`, { body: { path, content, encoding }, retry: "idempotent" });
  }

  /** A short-lived URL that takes the file as a raw PUT body, with no size limit. The URL is a secret. */
  async uploadUrl(id: string, path: string): Promise<string> {
    return (await this.request<{ url: string }>("POST", `${sandboxPath(id)}/files/upload-url`, { body: { path }, retry: "idempotent" })).url;
  }

  async setFileMode(id: string, path: string, mode: number): Promise<void> {
    await this.request("POST", `${sandboxPath(id)}/files/permissions`, { body: { path, mode: mode.toString(8) }, retry: "idempotent" });
  }

  async createFolder(id: string, path: string, mode: number): Promise<void> {
    await this.request("POST", `${sandboxPath(id)}/files/folder`, { body: { path, mode: mode.toString(8) }, retry: "idempotent" });
  }

  /** Puts a port on a stable HTTPS URL. Idempotent: the same port gets the same URL. */
  async hostPort(id: string, port: number, options: { public: boolean }): Promise<string> {
    return (await this.request<{ url: string }>("POST", `${sandboxPath(id)}/host`, { body: { port, public: options.public }, retry: "idempotent" })).url;
  }

  async usage(id: string): Promise<BoatUsage> {
    const usage = await this.request<{ seconds: number; dollars: number; running: boolean }>("GET", `${sandboxPath(id)}/usage`, { retry: "idempotent" });
    return { seconds: usage.seconds, usd: usage.dollars, running: usage.running };
  }

  /** Sends a raw body to a signed URL from `uploadUrl`. Failures name the status only, never the URL. */
  async upload(url: string, bytes: Uint8Array): Promise<void> {
    let response: Response;
    try {
      response = await this.fetch(url, { method: "PUT", body: new Blob([new Uint8Array(bytes)]), signal: this.signal(5 * 60_000) });
    } catch (error) {
      throw new WorkspaceError("Upload to the sandbox failed", { cause: scrubCause(error, url) });
    }
    if (!response.ok) throw new WorkspaceError(`Upload to the sandbox failed: HTTP ${response.status}`);
  }

  private async request<T = unknown>(
    method: string,
    path: string,
    options: { query?: Record<string, string>; body?: unknown; headers?: Record<string, string>; retry: RetryPolicy; timeoutMs?: number },
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value);
    const headers: Record<string, string> = { authorization: `Bearer ${this.options.apiKey}`, accept: "application/json", ...options.headers };
    if (options.body !== undefined) headers["content-type"] = "application/json";
    const retries = options.retry === "never" ? 0 : (this.options.retries ?? 4);
    const label = `Boat API ${method} ${path}`;

    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.fetch(url, {
          method,
          headers,
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: this.signal(options.timeoutMs ?? this.options.timeoutMs ?? 30_000),
        });
      } catch (error) {
        if (this.options.signal?.aborted) throw new WorkspaceError(`${label}: aborted`, { cause: scrubCause(error, this.options.apiKey) });
        // A request that may have reached the server is retried only when repeating it is harmless.
        if (options.retry === "idempotent" && attempt < retries) {
          await sleep(this.backoff(attempt));
          continue;
        }
        const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
        throw new WorkspaceError(`${label}: ${timedOut ? "timed out" : "network error"}`, { cause: scrubCause(error, this.options.apiKey) });
      }

      const text = await response.text();
      let body: unknown;
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        body = undefined;
      }
      if (response.ok) {
        if (body === undefined) throw new WorkspaceError(`${label}: response is not JSON`);
        return body as T;
      }

      const error = (body ?? {}) as ErrorBody;
      const code = error.error?.code ?? error.code;
      const message = error.error?.message ?? error.message ?? (body === undefined ? text.slice(0, 200) : "");
      if (attempt < retries && retryable(response.status, code, error, options.retry)) {
        const delay = serverDelayMs(response, error) ?? this.backoff(attempt);
        if (delay <= (this.options.maxRetryDelayMs ?? 30_000)) {
          await sleep(delay);
          continue;
        }
      }
      throw new BoatApiError(this.redact(`${label}: ${response.status}${code ? ` ${code}` : ""}${message ? `: ${message}` : ""}`), response.status, code);
    }
  }

  private signal(timeoutMs: number): AbortSignal {
    const timeout = AbortSignal.timeout(timeoutMs);
    return this.options.signal ? AbortSignal.any([timeout, this.options.signal]) : timeout;
  }

  private backoff(attempt: number): number {
    const base = this.options.backoffMs ?? 500;
    return base * 2 ** attempt + Math.random() * base;
  }

  /** The API never echoes the key, but an error message must not be the one place it does. */
  private redact(text: string): string {
    return text.replaceAll(this.options.apiKey, "[redacted]");
  }
}

interface BoatCommandResult {
  exitCode: number | null;
  signal?: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  oomKilled?: boolean;
}

interface BoatCommandStatus {
  status: "running" | "exited" | "lost";
  running: boolean;
  exitCode: number | null;
  signal?: string | null;
  oomKilled?: boolean;
  stdout: string;
  stderr: string;
}

function retryable(status: number, code: string | undefined, body: ErrorBody, policy: RetryPolicy): boolean {
  if (policy === "never") return false;
  // These prove the request was refused before anything ran.
  if (status === 429) return true;
  if (status === 409 && code === "sandbox_starting") return true;
  const details = body.error?.details;
  if (status === 502 && details?.retryable === true && (details.message === "sandbox_restoring" || body.message === "sandbox_restoring")) return true;
  if (policy === "refused") return false;
  return status >= 500 || (status === 409 && code === "idempotency_in_progress");
}

/** `Retry-After` on every 429, `retryAfterSeconds` on a 503, `retryAfter` on the per-IP limit. */
function serverDelayMs(response: Response, body: ErrorBody): number | undefined {
  const header = response.headers.get("retry-after");
  const seconds = header !== null && /^\d+$/.test(header.trim()) ? Number(header) : (body.retryAfterSeconds ?? body.retryAfter);
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

/**
 * Keeps only the error's kind and message, with the key and any URL query
 * removed: a network error can carry the request, headers or signed URL included.
 */
function scrubCause(error: unknown, secret?: string): Error | undefined {
  if (!(error instanceof Error)) return undefined;
  let message = error.message.replace(/(https?:\/\/[^\s?#]+)[?#]\S*/g, "$1");
  if (secret) message = message.replaceAll(secret, "[redacted]");
  const scrubbed = new Error(message);
  scrubbed.name = error.name;
  scrubbed.stack = `${error.name}: ${message}`;
  return scrubbed;
}

function sandboxPath(id: string): string {
  if (!SANDBOX_ID.test(id)) throw new WorkspaceError(`Not a Boat sandbox id: ${id.slice(0, 40)}`);
  return `/sandboxes/${id}`;
}

function processPath(processId: number): string {
  if (!Number.isInteger(processId) || processId < 1) throw new WorkspaceError(`Not a process id: ${processId}`);
  return String(processId);
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

/** Exit status from what the API reports: the code, else `128 + signal`, else SIGKILL for a timeout or the memory ceiling. */
function exitStatus(result: { exitCode: number | null; signal?: string | null; timedOut?: boolean; oomKilled?: boolean }): number {
  if (typeof result.exitCode === "number") return result.exitCode;
  const signal = result.signal?.trim().toUpperCase();
  if (signal && /^\d+$/.test(signal)) return 128 + Number(signal);
  const number = signal ? (constants.signals as Record<string, number | undefined>)[signal.startsWith("SIG") ? signal : `SIG${signal}`] : undefined;
  if (number) return 128 + number;
  return result.timedOut || result.oomKilled ? SIGKILL_EXIT : 1;
}

/** Single-quotes a word for POSIX sh. */
export function shellQuote(word: string): string {
  if (word.includes("\0")) throw new WorkspaceError("Command arguments cannot contain NUL");
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/** `K='v'` lines for an environment file, sourced with `set -a`. */
function envFileContent(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => {
      if (!ENV_KEY.test(key)) throw new WorkspaceError(`Invalid environment variable name: ${key.slice(0, 64)}`);
      return `${key}=${shellQuote(value)}\n`;
    })
    .join("");
}

/**
 * The shell text Boat runs for `cmd`: Boat takes one command string, with no
 * argv and no environment field. Arguments are quoted, never interpolated.
 * The caller's environment comes from `envFile` (deleted before the command
 * starts), so secrets such as a clone token stay out of the command text,
 * which Boat keeps in its command history and shows in process lists.
 *
 * With `runAs` the command runs as that user through `sudo`, with umask 007
 * so the sandbox user can read what it writes. The environment file is read
 * on stdin by the sandbox user and never becomes readable by `runAs`.
 */
export function commandScript(cmd: string[], cwd: string, options: { envFile?: string; runAs?: string } = {}): string {
  const [file] = cmd;
  if (!file) throw new WorkspaceError("Empty command");
  const argv = cmd.map(shellQuote).join(" ");
  const base = Object.entries(BASE_ENV).map(([key, value]) => `${key}=${shellQuote(value)}`);
  const f = options.envFile === undefined ? undefined : shellQuote(options.envFile);

  if (options.runAs === undefined) {
    const load = f ? `set -a; . ${f}; set +a; rm -f -- ${f}; ` : "";
    return `export ${base.join(" ")}; ${load}cd -- ${shellQuote(cwd)} && exec ${argv}`;
  }
  if (!RUN_AS.test(options.runAs)) throw new WorkspaceError(`Invalid user name: ${options.runAs.slice(0, 32)}`);
  // The target user's shell evaluates the file from stdin, then hands the command a closed-off stdin.
  const inner = f ? `umask 007; set -a; eval "$(cat)"; set +a; exec "$@" </dev/null` : `umask 007; exec "$@" </dev/null`;
  const open = f ? `exec <${f} && rm -f -- ${f} && ` : "";
  return `${open}cd -- ${shellQuote(cwd)} && exec sudo -n -H -u ${shellQuote(options.runAs)} -- env ${base.join(" ")} /bin/sh -c ${shellQuote(inner)} sh ${argv}`;
}

// Arguments are positional, never interpolated into the script.
const DOWNLOAD_SCRIPT = `set -e
mkdir -p "$(dirname "$2")"
curl -fsSL --retry 6 --retry-max-time 90 --max-time 60 "$1" -o "$2"
echo "$3  $2" | sha256sum -c - >/dev/null
chmod 755 "$2"`;

export interface BoatWorkspaceOptions extends BoatClientOptions {
  /** Machine size. Default `default` (4 vCPU, 8 GB). */
  type?: BoatSize;
  /** The sandbox stops itself after this long, even if `destroy()` is never called. Default 30 minutes; at most 30 days. */
  ttlSeconds?: number;
  /** At most 20; keys `[A-Za-z0-9][A-Za-z0-9._/-]{0,62}`, values up to 256 bytes. Never put personal data here. */
  labels?: Record<string, string>;
  /** Display name, up to 120 characters. */
  name?: string;
  /**
   * Runs once, in the background, after the sandbox is ready (as the sandbox
   * user, with passwordless sudo). `create()` waits for it and fails if it does.
   * Up to 64 KB. See `agentSandboxSetupScript`.
   */
  setupScript?: string;
  /** Default: a fresh UUID, so a create lost to a timeout or 5xx is retried without billing a second sandbox. */
  idempotencyKey?: string;
  /** How long `create()` waits for `ready` (and the setup script). Default 3 minutes. */
  readyTimeoutMs?: number;
  /** Between readiness polls. Default 1 s. */
  pollIntervalMs?: number;
}

/**
 * A Boat sandbox (boat.dev) per scan. Created with none of the account's
 * secrets (`noEnv`), no disk snapshots (stopping or deleting it erases the
 * disk) and monitoring off, so Boat keeps no copy of command output, which
 * holds source code. `destroy()` deletes it.
 *
 * Unlike the other backends, a workspace can be rebuilt from its id in a
 * later process (`attach`), and so can a detached command (`process`): one
 * invocation creates and starts work, later ones poll it.
 */
export class BoatWorkspace implements Workspace {
  readonly root = `${SANDBOX_HOME}/repo`;
  private destroying: Promise<void> | undefined;
  private installing: Promise<string> | undefined;
  private privateDir: Promise<void> | undefined;

  private constructor(
    private readonly client: BoatClient,
    readonly id: string,
    private readonly fetchImpl: typeof fetch,
  ) {}

  static async create(options: BoatWorkspaceOptions): Promise<BoatWorkspace> {
    const client = new BoatClient(options);
    const sandbox = await client.createSandbox(createBody(options), { idempotencyKey: options.idempotencyKey ?? crypto.randomUUID() });
    const workspace = new BoatWorkspace(client, sandbox.id, options.fetch ?? fetch);
    try {
      await workspace.waitUntilReady({ timeoutMs: options.readyTimeoutMs, pollIntervalMs: options.pollIntervalMs });
    } catch (error) {
      // A sandbox that never became usable still bills until it is gone.
      await workspace.destroy().catch(() => {});
      throw error;
    }
    return workspace;
  }

  /** Rebuilds the workspace for an existing sandbox, e.g. in a later server invocation. Fails if it no longer exists. */
  static async attach(id: string, options: BoatClientOptions): Promise<BoatWorkspace> {
    if (!SANDBOX_ID.test(id)) throw new WorkspaceError(`Not a Boat sandbox id: ${id.slice(0, 40)}`);
    const client = new BoatClient(options);
    try {
      await client.getSandbox(id);
    } catch (error) {
      if (error instanceof BoatApiError && error.status === 404) throw new WorkspaceError(`Sandbox not found: ${id}`, { cause: error });
      throw error;
    }
    return new BoatWorkspace(client, id, options.fetch ?? fetch);
  }

  /** Polls until the sandbox accepts commands and its setup script, if any, has finished. */
  async waitUntilReady(options: { timeoutMs?: number; pollIntervalMs?: number } = {}): Promise<void> {
    const timeoutMs = options.timeoutMs ?? 3 * 60_000;
    const deadline = Date.now() + timeoutMs;
    let last = "unknown";
    for (;;) {
      let sandbox: BoatSandbox;
      try {
        sandbox = await this.client.getSandbox(this.id);
      } catch (error) {
        // A create that could not get a machine reports `cancelled` once, then 404.
        if (error instanceof BoatApiError && error.status === 404) throw new WorkspaceError("Sandbox was cancelled before it started", { cause: error });
        throw error;
      }
      last = sandbox.setupStatus ? `${sandbox.state}, setup ${sandbox.setupStatus}` : sandbox.state;
      if (sandbox.setupStatus === "failed") throw new WorkspaceError(`Sandbox setup failed: ${(sandbox.setupError ?? "no detail").slice(0, 2_000)}`);
      if (sandbox.state === "ready" || sandbox.state === "idle" || sandbox.state === "running") {
        if (sandbox.setupStatus !== "pending" && sandbox.setupStatus !== "running") return;
      } else if (sandbox.state === "error" || sandbox.state === "cancelled" || sandbox.state === "archiving" || sandbox.state === "archived") {
        throw new WorkspaceError(`Sandbox is ${sandbox.state}${sandbox.error ? `: ${sandbox.error.slice(0, 500)}` : ""}`);
      }
      if (Date.now() >= deadline) throw new WorkspaceError(`Sandbox did not become ready in ${Math.round(timeoutMs / 1000)}s (last: ${last})`);
      await sleep(Math.min(options.pollIntervalMs ?? 1_000, Math.max(0, deadline - Date.now())));
    }
  }

  async clone(repo: RepoRef, options: CloneOptions): Promise<void> {
    const { cmd, env } = cloneCommand(this.root, repo, options);
    const result = await this.run(cmd, SANDBOX_HOME, { env, timeoutMs: options.timeoutMs ?? DEFAULT_CLONE_TIMEOUT_MS });
    if (result.exitCode !== 0) {
      throw new WorkspaceError(result.timedOut ? "Clone timed out" : `Clone failed: ${result.stderr.trim()}`);
    }
  }

  /** Runs a command in `root` and waits for it, up to 600 s (Boat's cap); use `spawn` for longer work. */
  exec(cmd: string[], options: ExecOptions = {}): Promise<ExecResult> {
    return this.run(cmd, this.root, options);
  }

  async startDetached(cmd: string[], options: { env?: Record<string, string> } = {}): Promise<void> {
    await this.spawn(cmd, options);
  }

  /**
   * Starts a long-running command in `root` and returns a handle to poll or
   * stop it. Detached commands have no time limit, but they end when the
   * sandbox stops: keep the TTL ahead of them with `extendTtl`.
   * `runAs` runs it as another user of the sandbox (see `agentSandboxSetupScript`).
   */
  async spawn(cmd: string[], options: { env?: Record<string, string>; runAs?: string } = {}): Promise<BoatProcess> {
    this.assertUsable();
    const script = commandScript(cmd, this.root, { envFile: await this.writeEnvFile(options.env), runAs: options.runAs });
    const { processId } = await this.client.startCommand(this.id, script);
    return this.process(processId);
  }

  /** Rebuilds a handle for a command started by `spawn`, e.g. in a later server invocation. */
  process(processId: number): BoatProcess {
    processPath(processId);
    const { client, id } = this;
    return {
      sandboxId: id,
      processId,
      async status(options = {}) {
        const status = await client.commandStatus(id, processId, options);
        // For a lost process the exit code is only Boat's best-effort probe.
        const exitCode = status.status === "exited" ? exitStatus(status) : status.status === "lost" ? status.exitCode : null;
        return { state: status.status, exitCode, stdout: status.stdout, stderr: status.stderr };
      },
      stop: () => client.stopCommand(id, processId),
    };
  }

  /** Reads a UTF-8 file by checkout-relative path, up to 5 MiB. Refuses paths that resolve outside the checkout. */
  async readFile(path: string): Promise<string> {
    this.assertUsable();
    // Symlinks can only reach files inside the sandbox, which holds nothing but the checkout and its tools.
    try {
      return (await this.client.readFile(this.id, resolveInside(this.root, path), "utf8")).content;
    } catch (error) {
      throw fileError(error, path);
    }
  }

  /** Reads any file under /home/user or /tmp as bytes, up to 5 MiB. */
  async readBytes(path: string): Promise<Buffer> {
    this.assertUsable();
    try {
      return Buffer.from((await this.client.readFile(this.id, sandboxFilePath(path), "base64")).content, "base64");
    } catch (error) {
      throw fileError(error, path);
    }
  }

  /**
   * Writes files under /home/user or /tmp, creating folders. Text goes as
   * UTF-8, bytes as base64; anything over 5 MiB goes through a signed upload URL.
   */
  async writeFiles(files: Array<{ path: string; content: string | Uint8Array; mode?: number }>): Promise<void> {
    this.assertUsable();
    const checked = files.map((file) => ({ ...file, path: sandboxFilePath(file.path) }));
    for (const file of checked) {
      const bytes = typeof file.content === "string" ? Buffer.byteLength(file.content) : file.content.byteLength;
      if (bytes > BOAT_MAX_INLINE_FILE_BYTES) {
        const content = typeof file.content === "string" ? Buffer.from(file.content) : file.content;
        await this.client.upload(await this.client.uploadUrl(this.id, file.path), content);
      } else if (typeof file.content === "string") {
        await this.client.writeFile(this.id, file.path, file.content, "utf8");
      } else {
        await this.client.writeFile(this.id, file.path, Buffer.from(file.content).toString("base64"), "base64");
      }
      if (file.mode !== undefined) await this.client.setFileMode(this.id, file.path, file.mode);
    }
  }

  /** A directory for agent-session files (the CLI, its config, its reports), outside the checkout. */
  get agentDir(): string {
    return `${SANDBOX_HOME}/agent`;
  }

  /** Writes files into `agentDir`. Names are plain file names, never paths. Returns their absolute paths. */
  async writeAgentFiles(files: Array<{ name: string; content: string; mode?: number }>): Promise<string[]> {
    this.assertUsable();
    for (const file of files) if (!AGENT_FILE.test(file.name)) throw new WorkspaceError(`Bad agent file name: ${file.name}`);
    const entries = files.map((file) => ({ path: `${this.agentDir}/${file.name}`, content: file.content, mode: file.mode }));
    await this.writeFiles(entries);
    return entries.map((entry) => entry.path);
  }

  /** Reads a file from `agentDir`; an absent file reads as empty. */
  async readAgentFile(name: string): Promise<string> {
    this.assertUsable();
    if (!AGENT_FILE.test(name)) throw new WorkspaceError(`Bad agent file name: ${name}`);
    try {
      return (await this.client.readFile(this.id, `${this.agentDir}/${name}`, "utf8")).content;
    } catch (error) {
      if (isNotFound(error)) return "";
      throw fileError(error, name);
    }
  }

  /**
   * Writes files into a directory only the sandbox user can enter (mode 700), outside the checkout and
   * `agentDir`: state a later invocation reads back, out of an agent's reach. Names are plain file names.
   */
  async writePrivateFiles(files: Array<{ name: string; content: string }>): Promise<void> {
    this.assertUsable();
    for (const file of files) if (!AGENT_FILE.test(file.name) || file.name.startsWith("env-")) throw new WorkspaceError(`Bad private file name: ${file.name}`);
    await this.ensurePrivateDir();
    await this.writeFiles(files.map((file) => ({ path: `${PRIVATE_DIR}/${file.name}`, content: file.content, mode: 0o600 })));
  }

  /** Reads a file `writePrivateFiles` wrote; undefined when there is none. */
  async readPrivateFile(name: string): Promise<string | undefined> {
    this.assertUsable();
    if (!AGENT_FILE.test(name) || name.startsWith("env-")) throw new WorkspaceError(`Bad private file name: ${name}`);
    try {
      return (await this.client.readFile(this.id, `${PRIVATE_DIR}/${name}`, "utf8")).content;
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw fileError(error, name);
    }
  }

  /** Reads a file in the private directory as bytes, up to 5 MiB; undefined when there is none. */
  async readPrivateBytes(name: string): Promise<Buffer | undefined> {
    this.assertUsable();
    if (!AGENT_FILE.test(name) || name.startsWith("env-")) throw new WorkspaceError(`Bad private file name: ${name}`);
    try {
      return Buffer.from((await this.client.readFile(this.id, `${PRIVATE_DIR}/${name}`, "base64")).content, "base64");
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw fileError(error, name);
    }
  }

  /** The directory `writePrivateFiles` writes to, for a command that reads or writes files there. */
  get privateFilesDir(): string {
    return PRIVATE_DIR;
  }

  /** Moves the auto-stop deadline to now + `ttlSeconds`. */
  async extendTtl(ttlSeconds: number): Promise<void> {
    this.assertUsable();
    await this.client.setTtl(this.id, checkTtl(ttlSeconds));
  }

  /** Machine time so far, for billing. Read it before `destroy()`: a deleted sandbox has no usage to read. */
  usage(): Promise<BoatUsage> {
    return this.client.usage(this.id);
  }

  /**
   * Puts the indexer in the sandbox, runs it detached on a hosted port with a
   * random token, and waits until it answers over HTTPS. The port is hosted
   * without Boat's URL token (which would sit in the query string); the
   * indexer's own bearer token guards it.
   */
  installIndexer(binary: IndexerBinary): Promise<void> {
    return this.install(binary).then(() => undefined);
  }

  async startIndexer(binary: IndexerBinary, options: { readyTimeoutMs?: number } = {}): Promise<IndexerHandle> {
    const path = await this.install(binary);
    this.assertUsable();
    const token = crypto.randomUUID();
    await this.spawn([path, "serve", this.root, "--host", "0.0.0.0", "--port", String(INDEXER_PORT)], { env: { SANDCHEST_INDEX_TOKEN: token } });
    const url = (await this.client.hostPort(this.id, INDEXER_PORT, { public: true })).replace(/\/$/, "");
    await waitForHealth(this.fetchImpl, url, token, options.readyTimeoutMs ?? 30_000);
    return { url, token };
  }

  private install(binary: IndexerBinary): Promise<string> {
    this.assertUsable();
    this.installing ??= (async () => {
      const path = `${SANDBOX_HOME}/bin/sandchest-index`;
      if ("path" in binary) {
        await this.writeFiles([{ path, content: await readFile(binary.path), mode: 0o755 }]);
      } else {
        // Downloaded inside the sandbox and verified before it runs.
        const result = await this.run(["sh", "-c", DOWNLOAD_SCRIPT, "download", binary.url, path, binary.sha256], SANDBOX_HOME, { timeoutMs: 180_000 });
        if (result.exitCode !== 0) throw new WorkspaceError(`Indexer download failed: ${result.stderr.trim()}`);
      }
      return path;
    })();
    return this.installing;
  }

  /** Deletes the sandbox and its disk. Idempotent: a sandbox that is already gone counts as deleted. */
  destroy(): Promise<void> {
    this.destroying ??= this.client.deleteSandbox(this.id).then(
      () => undefined,
      (error: unknown) => {
        // Allow a retry: a sandbox that failed to delete must not be forgotten.
        this.destroying = undefined;
        throw new WorkspaceError("Failed to delete sandbox", { cause: error });
      },
    );
    return this.destroying;
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.destroy();
  }

  private async run(cmd: string[], cwd: string, options: ExecOptions): Promise<ExecResult> {
    this.assertUsable();
    if (!cmd[0]) throw new WorkspaceError("Empty command");
    const timeoutSeconds = options.timeoutMs === undefined ? MAX_COMMAND_SECONDS : Math.max(1, Math.ceil(options.timeoutMs / 1000));
    if (timeoutSeconds > MAX_COMMAND_SECONDS) {
      throw new WorkspaceError(`Commands that wait are capped at ${MAX_COMMAND_SECONDS}s; use spawn() for longer ones`);
    }
    const script = commandScript(cmd, cwd, { envFile: await this.writeEnvFile(options.env) });

    const started = performance.now();
    const finished = await this.client.runCommand(this.id, script, timeoutSeconds);
    return {
      exitCode: exitStatus(finished),
      stdout: finished.stdout,
      stderr: finished.stderr,
      timedOut: finished.timedOut,
      durationMs: performance.now() - started,
    };
  }

  /** Writes the caller's environment to a private file the command sources and deletes. */
  private async writeEnvFile(env: Record<string, string> | undefined): Promise<string | undefined> {
    if (!env || Object.keys(env).length === 0) return undefined;
    const content = envFileContent(env);
    await this.ensurePrivateDir();
    const path = `${PRIVATE_DIR}/env-${crypto.randomUUID()}`;
    await this.client.writeFile(this.id, path, content, "utf8");
    return path;
  }

  /** Creates the private directory once per workspace object (again after a failure). */
  private ensurePrivateDir(): Promise<void> {
    this.privateDir ??= this.client.createFolder(this.id, PRIVATE_DIR, 0o700).catch((error: unknown) => {
      this.privateDir = undefined;
      throw error;
    });
    return this.privateDir;
  }

  private assertUsable(): void {
    if (this.destroying) throw new WorkspaceError("Workspace has been destroyed");
  }
}

function createBody(options: BoatWorkspaceOptions): Record<string, unknown> {
  const type = options.type ?? "default";
  if (!BOAT_SIZES.includes(type)) throw new WorkspaceError(`Unknown Boat sandbox type: ${String(type).slice(0, 20)}`);
  const labels = options.labels ?? {};
  const entries = Object.entries(labels);
  if (entries.length > 20) throw new WorkspaceError("At most 20 labels");
  for (const [key, value] of entries) {
    if (!LABEL_KEY.test(key)) throw new WorkspaceError(`Invalid label key: ${key.slice(0, 64)}`);
    if (Buffer.byteLength(value) > 256) throw new WorkspaceError(`Label ${key} is longer than 256 bytes`);
  }
  if (options.name !== undefined && (options.name.length === 0 || options.name.length > 120)) throw new WorkspaceError("Name must be 1 to 120 characters");
  if (options.setupScript !== undefined && Buffer.byteLength(options.setupScript) > 65_536) throw new WorkspaceError("Setup script is larger than 64 KB");
  return {
    type,
    ttlSeconds: checkTtl(options.ttlSeconds ?? 30 * 60),
    // None of the account's secrets: the sandbox runs untrusted code.
    noEnv: true,
    // Nothing to resume: no snapshot CPU cost, and stopping erases the disk.
    snapshots: false,
    // Boat keeps no copy of command output (source code) or process lists.
    monitoring: false,
    labels,
    ...(options.name === undefined ? {} : { name: options.name }),
    ...(options.setupScript === undefined ? {} : { setupScript: options.setupScript }),
  };
}

function checkTtl(ttlSeconds: number): number {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_TTL_SECONDS) {
    throw new WorkspaceError(`TTL must be a whole number of seconds from 1 to ${MAX_TTL_SECONDS}`);
  }
  return ttlSeconds;
}

/** An absolute, normalised path under /home/user or /tmp: the only places Boat's file API reaches. */
function sandboxFilePath(path: string): string {
  const normal = posix.normalize(path);
  if (normal !== path || !(path.startsWith(`${SANDBOX_HOME}/`) || path.startsWith("/tmp/"))) {
    throw new WorkspaceError(`Path must be absolute under ${SANDBOX_HOME} or /tmp: ${path.slice(0, 200)}`);
  }
  return path;
}

/** Boat documents 413 for a read over 5 MiB; a missing file is assumed to answer 404 or a `not_found`-style code. */
function isNotFound(error: unknown): boolean {
  if (!(error instanceof BoatApiError)) return false;
  return error.status === 404 || /not.?found|no.?such|enoent/i.test(`${error.code ?? ""} ${error.message}`);
}

function fileError(error: unknown, path: string): unknown {
  if (!(error instanceof BoatApiError)) return error;
  if (error.status === 413) return new WorkspaceError(`File too large to read (over ${BOAT_MAX_INLINE_FILE_BYTES} bytes): ${path}`, { cause: error });
  if (isNotFound(error)) return new WorkspaceError(`File not found: ${path}`, { cause: error });
  return error;
}

/** Polls `/health` until the daemon answers. */
async function waitForHealth(fetchImpl: typeof fetch, url: string, token: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(`${url}/health`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000) });
      if (response.ok) return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = (error as Error).message;
    }
    await sleep(150);
  }
  throw new WorkspaceError(`Indexer did not become ready: ${last}`);
}

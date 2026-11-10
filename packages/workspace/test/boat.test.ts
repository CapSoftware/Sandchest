/** BoatWorkspace and its HTTP client against a fake Boat API: no network, no real sandbox. */
import { describe, expect, test } from "bun:test";
import { WorkspaceError } from "../src";
import { BoatApiError, BoatClient, BoatWorkspace, commandScript } from "../src/boat";
import { BASE_ENV } from "../src/shared";

const API_KEY = "boat_test_0123456789abcdef";
const ID = "bx_23456789";
const BASE = "https://boat.test/api/v1";

interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  body: Record<string, unknown> | undefined;
  signal: AbortSignal | undefined;
}

type Reply = Response | ((call: Call) => Response | Promise<Response>);

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const apiError = (status: number, code: string, message = code, details?: Record<string, unknown>) =>
  json(status, { ok: false, type: "sandbox.error", status, code, message, error: { code, message, status, details }, requestId: "req_test" });
const sandbox = (state: string, extra: Record<string, unknown> = {}) => ({ id: ID, name: "test", state, desktopAvailable: false, snapshotAvailable: false, ...extra });

/**
 * A fake Boat API. Routes are `"METHOD /path"` (path relative to /api/v1) and
 * answer with queued replies, the last one repeating. Every call is recorded.
 */
function fakeBoat(routes: Record<string, Reply | Reply[]>) {
  const calls: Call[] = [];
  const queues = new Map(Object.entries(routes).map(([key, reply]) => [key, Array.isArray(reply) ? [...reply] : [reply]]));
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = {
      method: init?.method ?? "GET",
      path: url.pathname.replace("/api/v1", ""),
      query: url.searchParams,
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
      signal: init?.signal ?? undefined,
    };
    calls.push(call);
    const key = url.origin === "https://boat.test" ? `${call.method} ${call.path}` : `${call.method} ${url.origin}${url.pathname}`;
    const queue = queues.get(key);
    if (!queue?.length) return apiError(404, "not_found", `no fake route for ${key}`);
    const reply = queue.length > 1 ? queue.shift()! : queue[0]!;
    return typeof reply === "function" ? reply(call) : reply.clone();
  }) as typeof fetch;
  const options = { apiKey: API_KEY, baseUrl: BASE, fetch: fetchImpl, backoffMs: 0, pollIntervalMs: 0 };
  return { calls, options, fetch: fetchImpl, count: (key: string) => calls.filter((c) => `${c.method} ${c.path}` === key).length };
}

const READY = { "GET /sandboxes/bx_23456789": json(200, { ok: true, type: "sandbox.info", sandbox: sandbox("ready") }) };
const CREATED = { "POST /sandboxes": json(202, { ok: true, type: "sandbox.created", status: "provisioning", ttlSeconds: 1800, sandbox: sandbox("provisioning") }) };

async function attached(routes: Record<string, Reply | Reply[]>) {
  const boat = fakeBoat({ ...READY, ...routes });
  const workspace = await BoatWorkspace.attach(ID, boat.options);
  boat.calls.length = 0;
  return { ...boat, workspace };
}

describe("BoatWorkspace.create", () => {
  test("creates a secret-free, snapshot-free sandbox, polls until ready, and authenticates every call", async () => {
    const boat = fakeBoat({
      ...CREATED,
      "GET /sandboxes/bx_23456789": [
        json(200, { ok: true, sandbox: sandbox("provisioning") }),
        json(200, { ok: true, sandbox: sandbox("cloning") }),
        json(200, { ok: true, sandbox: sandbox("idle") }),
      ],
    });
    const workspace = await BoatWorkspace.create({ ...boat.options, type: "large", ttlSeconds: 900, labels: { scan: "s_123" }, name: "scan" });

    expect(workspace.id).toBe(ID);
    expect(workspace.root).toBe("/home/user/repo");
    const [create] = boat.calls;
    expect(create!.body).toEqual({ type: "large", ttlSeconds: 900, noEnv: true, snapshots: false, monitoring: false, labels: { scan: "s_123" }, name: "scan" });
    expect(create!.headers.get("idempotency-key")).toMatch(/^[0-9a-f-]{36}$/);
    expect(boat.count("GET /sandboxes/bx_23456789")).toBe(3);
    for (const call of boat.calls) expect(call.headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
  });

  test("defaults to the default size and a 30-minute TTL", async () => {
    const boat = fakeBoat({ ...CREATED, ...READY });
    await BoatWorkspace.create(boat.options);
    expect(boat.calls[0]!.body).toMatchObject({ type: "default", ttlSeconds: 1800, labels: {} });
  });

  test("waits for the setup script, and fails (deleting the sandbox) when it fails", async () => {
    const waits = fakeBoat({
      ...CREATED,
      "GET /sandboxes/bx_23456789": [
        json(200, { ok: true, sandbox: sandbox("ready", { setupStatus: "pending" }) }),
        json(200, { ok: true, sandbox: sandbox("ready", { setupStatus: "running" }) }),
        json(200, { ok: true, sandbox: sandbox("ready", { setupStatus: "done" }) }),
      ],
    });
    await BoatWorkspace.create({ ...waits.options, setupScript: "echo hi" });
    expect(waits.calls[0]!.body).toMatchObject({ setupScript: "echo hi" });
    expect(waits.count("GET /sandboxes/bx_23456789")).toBe(3);

    const fails = fakeBoat({
      ...CREATED,
      "GET /sandboxes/bx_23456789": json(200, { ok: true, sandbox: sandbox("ready", { setupStatus: "failed", setupError: "exit 1: iptables is not installed" }) }),
      "DELETE /sandboxes/bx_23456789": json(202, { ok: true, type: "sandbox.deleting", operation: {} }),
    });
    await expect(BoatWorkspace.create({ ...fails.options, setupScript: "exit 1" })).rejects.toThrow("Sandbox setup failed: exit 1: iptables is not installed");
    expect(fails.count("DELETE /sandboxes/bx_23456789")).toBe(1);
  });

  test("gives up at the deadline, and on a sandbox that errors or is cancelled, deleting it each time", async () => {
    const slow = fakeBoat({
      ...CREATED,
      "GET /sandboxes/bx_23456789": json(200, { ok: true, sandbox: sandbox("provisioning") }),
      "DELETE /sandboxes/bx_23456789": json(202, { ok: true }),
    });
    await expect(BoatWorkspace.create({ ...slow.options, readyTimeoutMs: 30, pollIntervalMs: 5 })).rejects.toThrow(/did not become ready in 0s \(last: provisioning\)/);
    expect(slow.count("DELETE /sandboxes/bx_23456789")).toBe(1);

    const broken = fakeBoat({
      ...CREATED,
      "GET /sandboxes/bx_23456789": json(200, { ok: true, sandbox: sandbox("error", { error: "machine failed" }) }),
      "DELETE /sandboxes/bx_23456789": json(202, { ok: true }),
    });
    await expect(BoatWorkspace.create(broken.options)).rejects.toThrow("Sandbox is error: machine failed");

    // `cancelled` is reported once, then the sandbox answers 404.
    const cancelled = fakeBoat({ ...CREATED, "GET /sandboxes/bx_23456789": apiError(404, "not_found"), "DELETE /sandboxes/bx_23456789": apiError(404, "not_found") });
    await expect(BoatWorkspace.create(cancelled.options)).rejects.toThrow("cancelled before it started");
  });

  test("rejects bad options before calling the API", async () => {
    const boat = fakeBoat({});
    await expect(BoatWorkspace.create({ ...boat.options, ttlSeconds: 0 })).rejects.toThrow(WorkspaceError);
    await expect(BoatWorkspace.create({ ...boat.options, ttlSeconds: 2_592_001 })).rejects.toThrow(WorkspaceError);
    await expect(BoatWorkspace.create({ ...boat.options, labels: { "bad key": "x" } })).rejects.toThrow("Invalid label key");
    await expect(BoatWorkspace.create({ ...boat.options, labels: { k: "x".repeat(257) } })).rejects.toThrow("256 bytes");
    await expect(BoatWorkspace.create({ ...boat.options, type: "huge" as "large" })).rejects.toThrow("Unknown Boat sandbox type");
    expect(() => new BoatClient({ apiKey: "" })).toThrow(WorkspaceError);
    expect(boat.calls).toHaveLength(0);
  });
});

describe("BoatWorkspace.attach", () => {
  test("rebuilds a workspace for an existing sandbox and refuses ids that are not Boat ids", async () => {
    const boat = fakeBoat(READY);
    const workspace = await BoatWorkspace.attach(ID, boat.options);
    expect(workspace.id).toBe(ID);
    expect(boat.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /sandboxes/bx_23456789"]);

    await expect(BoatWorkspace.attach("../../me", boat.options)).rejects.toThrow("Not a Boat sandbox id");
    const gone = fakeBoat({ "GET /sandboxes/bx_23456789": apiError(404, "not_found") });
    await expect(BoatWorkspace.attach(ID, gone.options)).rejects.toThrow(`Sandbox not found: ${ID}`);
  });
});

describe("BoatWorkspace.exec", () => {
  test("sends one quoted command string with the base environment, in the checkout", async () => {
    const { workspace, calls } = await attached({
      "POST /sandboxes/bx_23456789/commands": json(200, { ok: true, type: "command.finished", success: true, exitCode: 0, stdout: "hi\n", stderr: "", timedOut: false }),
    });
    const result = await workspace.exec(["echo", "it's $HOME"], { timeoutMs: 5_000 });

    expect(result).toMatchObject({ exitCode: 0, stdout: "hi\n", stderr: "", timedOut: false });
    const body = calls[0]!.body!;
    expect(body.timeoutSeconds).toBe(5);
    expect(body.command).toBe(commandScript(["echo", "it's $HOME"], "/home/user/repo"));
    expect(body.command).toContain(`cd -- '/home/user/repo' && exec 'echo' 'it'\\''s $HOME'`);
    for (const [key, value] of Object.entries(BASE_ENV)) expect(body.command).toContain(`${key}='${value}'`);
  });

  test("returns non-zero exits, signals and timeouts without throwing", async () => {
    const { workspace } = await attached({
      "POST /sandboxes/bx_23456789/commands": [
        json(200, { ok: true, success: false, exitCode: 3, stdout: "out\n", stderr: "err\n", timedOut: false }),
        json(200, { ok: true, success: false, exitCode: null, signal: "SIGKILL", stdout: "", stderr: "", timedOut: true }),
        json(200, { ok: true, success: false, exitCode: null, signal: "TERM", stdout: "", stderr: "", timedOut: false }),
      ],
    });
    expect(await workspace.exec(["sh", "-c", "exit 3"])).toMatchObject({ exitCode: 3, stdout: "out\n", stderr: "err\n", timedOut: false });
    expect(await workspace.exec(["sleep", "30"], { timeoutMs: 1_000 })).toMatchObject({ exitCode: 137, timedOut: true });
    expect(await workspace.exec(["sleep", "30"])).toMatchObject({ exitCode: 143, timedOut: false });
  });

  test("waits at most Boat's 600 s cap, the default when no timeout is given", async () => {
    const { workspace, calls } = await attached({
      "POST /sandboxes/bx_23456789/commands": json(200, { ok: true, exitCode: 0, stdout: "", stderr: "", timedOut: false }),
    });
    await workspace.exec(["true"]);
    expect(calls[0]!.body!.timeoutSeconds).toBe(600);
    await expect(workspace.exec(["true"], { timeoutMs: 600_001 })).rejects.toThrow("use spawn()");
    await expect(workspace.exec([])).rejects.toThrow("Empty command");
  });

  test("passes the caller's environment through a private file, never the command text", async () => {
    const { workspace, calls } = await attached({
      "POST /sandboxes/bx_23456789/files/folder": json(200, { ok: true, type: "folder.created" }),
      "PUT /sandboxes/bx_23456789/files": json(200, { ok: true, type: "file.written" }),
      "POST /sandboxes/bx_23456789/commands": json(200, { ok: true, exitCode: 0, stdout: "", stderr: "", timedOut: false }),
    });
    await workspace.exec(["env"], { env: { SECRET: "s3cr3t'value" } });
    await workspace.exec(["env"], { env: { OTHER: "x" } });

    const [folder, file, command] = calls;
    expect(folder).toMatchObject({ method: "POST", path: "/sandboxes/bx_23456789/files/folder", body: { path: "/home/user/.sandchest", mode: "700" } });
    expect(file!.body).toMatchObject({ encoding: "utf8", content: "SECRET='s3cr3t'\\''value'\n" });
    const envPath = file!.body!.path as string;
    expect(envPath).toMatch(/^\/home\/user\/\.sandchest\/env-[0-9a-f-]{36}$/);
    expect(command!.body!.command).not.toContain("s3cr3t");
    expect(command!.body!.command).toContain(`set -a; . '${envPath}'; set +a; rm -f -- '${envPath}'`);
    // The private directory is made once per workspace.
    expect(calls.filter((c) => c.path.endsWith("/files/folder"))).toHaveLength(1);
    await expect(workspace.exec(["env"], { env: { "BAD-NAME": "x" } })).rejects.toThrow("Invalid environment variable name");
  });
});

describe("BoatWorkspace.clone", () => {
  test("keeps the token out of the command, and reports git's error", async () => {
    const { workspace, calls } = await attached({
      "POST /sandboxes/bx_23456789/files/folder": json(200, { ok: true }),
      "PUT /sandboxes/bx_23456789/files": json(200, { ok: true }),
      "POST /sandboxes/bx_23456789/commands": [
        json(200, { ok: true, exitCode: 0, stdout: "", stderr: "", timedOut: false }),
        json(200, { ok: true, exitCode: 128, stdout: "", stderr: "fatal: couldn't find remote ref missing\n", timedOut: false }),
        json(200, { ok: true, exitCode: null, signal: "SIGKILL", stdout: "", stderr: "", timedOut: true }),
      ],
    });
    const repo = { url: "https://git.example.com/acme/app.git", ref: "0123abc" };
    await workspace.clone(repo, { depth: 1, token: "ghs_secret_token" });

    const command = calls.find((c) => c.path.endsWith("/commands"))!;
    expect(command.body!.command).not.toContain("ghs_secret_token");
    expect(command.body!.command).toContain("cd -- '/home/user' && exec 'sh' '-c'");
    expect(command.body!.timeoutSeconds).toBe(600);
    const envFile = calls.find((c) => c.method === "PUT")!.body!.content as string;
    expect(envFile).toContain("GIT_CONFIG_KEY_0='http.https://git.example.com/.extraHeader'");

    await expect(workspace.clone({ ...repo, ref: "missing" }, { depth: 1 })).rejects.toThrow("Clone failed: fatal: couldn't find remote ref missing");
    await expect(workspace.clone(repo, { depth: 1, timeoutMs: 1_000 })).rejects.toThrow("Clone timed out");
  });
});

describe("detached commands", () => {
  test("start, poll, finish and stop, and can be picked up again from ids alone", async () => {
    const { workspace, calls, options } = await attached({
      "POST /sandboxes/bx_23456789/commands": json(200, { ok: true, type: "command.started", success: true, processId: 42, pid: 4242, command: "x", startedAt: "2026-11-09T00:00:00Z" }),
      "GET /sandboxes/bx_23456789/commands/42": [
        json(200, { ok: true, processId: 42, status: "running", running: true, exitCode: null, stdout: "working", stderr: "" }),
        json(200, { ok: true, processId: 42, status: "exited", running: false, exitCode: 0, stdout: "done", stderr: "" }),
        json(200, { ok: true, processId: 42, status: "exited", running: false, exitCode: null, signal: "SIGTERM", stdout: "", stderr: "" }),
      ],
      "DELETE /sandboxes/bx_23456789/commands/42": [json(200, { ok: true, type: "command.stopped", processId: 42, running: false, signaled: true }), apiError(404, "not_found")],
    });
    const process = await workspace.spawn(["agent", "--run"], { env: undefined });
    expect(process).toMatchObject({ sandboxId: ID, processId: 42 });
    expect(calls[0]!.body).toMatchObject({ detached: true });
    expect(calls[0]!.body!.timeoutSeconds).toBeUndefined();

    expect(await process.status()).toEqual({ state: "running", exitCode: null, stdout: "working", stderr: "" });
    // Tails are capped, so a poll never pulls Boat's 8 MiB default.
    expect(calls.at(-1)!.query.get("tailBytes")).toBe("65536");

    // A later invocation: attach by sandbox id, rebuild the process by its id.
    const later = await BoatWorkspace.attach(ID, options);
    const again = later.process(42);
    expect(await again.status({ tailBytes: 10 })).toEqual({ state: "exited", exitCode: 0, stdout: "done", stderr: "" });
    expect(calls.at(-1)!.query.get("tailBytes")).toBe("10");
    expect((await again.status()).exitCode).toBe(143);

    await again.stop();
    await again.stop(); // already gone
    expect(() => later.process(0)).toThrow("Not a process id");
  });

  test("runs as another user through sudo, its environment read from stdin", () => {
    const script = commandScript(["agent", "run"], "/home/user/repo", { envFile: "/home/user/.sandchest/env-1", runAs: "sandchest-agent" });
    expect(script).toStartWith("exec <'/home/user/.sandchest/env-1' && rm -f -- '/home/user/.sandchest/env-1' && cd -- '/home/user/repo' && exec sudo -n -H -u 'sandchest-agent' -- env ");
    expect(script).toContain(`'umask 007; set -a; eval "$(cat)"; set +a; exec "$@" </dev/null' sh 'agent' 'run'`);
    expect(() => commandScript(["x"], "/", { runAs: "root; reboot" })).toThrow("Invalid user name");
    expect(() => commandScript(["x\0y"], "/")).toThrow("NUL");
  });

  test("startDetached starts a command and forgets the handle", async () => {
    const { workspace, calls } = await attached({ "POST /sandboxes/bx_23456789/commands": json(200, { ok: true, processId: 7, pid: 1 }) });
    await workspace.startDetached(["npm", "run", "start"]);
    expect(calls[0]!.body).toMatchObject({ detached: true });
    expect(calls[0]!.body!.command).toEndWith(`cd -- '/home/user/repo' && exec 'npm' 'run' 'start'`);
  });
});

describe("files", () => {
  test("reads checkout files as text and refuses paths outside the checkout", async () => {
    const { workspace, calls } = await attached({
      "GET /sandboxes/bx_23456789/files": json(200, { ok: true, type: "file.read", success: true, path: "/home/user/repo/app.ts", encoding: "utf8", size: 5, content: "hello" }),
    });
    expect(await workspace.readFile("app.ts")).toBe("hello");
    expect(calls[0]!.query.get("path")).toBe("/home/user/repo/app.ts");
    expect(calls[0]!.query.get("encoding")).toBe("utf8");
    await expect(workspace.readFile("../../etc/passwd")).rejects.toThrow("escapes the checkout");
  });

  test("names the read cap, and reports missing files", async () => {
    const { workspace } = await attached({
      "GET /sandboxes/bx_23456789/files": [
        apiError(413, "file_too_large", "File is larger than 5 MiB", { maxBytes: 5_242_880, sizeBytes: 9_000_000 }),
        apiError(404, "not_found", "No such file"),
        apiError(404, "not_found", "No such file"),
      ],
    });
    await expect(workspace.readFile("big.bin")).rejects.toThrow("File too large to read (over 5242880 bytes): big.bin");
    await expect(workspace.readFile("missing.txt")).rejects.toThrow("File not found: missing.txt");
    expect(await workspace.readAgentFile("report.json")).toBe("");
  });

  test("writes text as UTF-8 and bytes as base64, sets modes, and round-trips binary", async () => {
    const bytes = new Uint8Array([0, 255, 1, 254]);
    const { workspace, calls } = await attached({
      "PUT /sandboxes/bx_23456789/files": json(200, { ok: true }),
      "POST /sandboxes/bx_23456789/files/permissions": json(200, { ok: true }),
      "GET /sandboxes/bx_23456789/files": json(200, { ok: true, encoding: "base64", size: 4, content: Buffer.from(bytes).toString("base64") }),
    });
    await workspace.writeFiles([
      { path: "/home/user/agent/config.json", content: "{}" },
      { path: "/tmp/tool", content: bytes, mode: 0o755 },
    ]);
    expect(calls[0]!.body).toEqual({ path: "/home/user/agent/config.json", content: "{}", encoding: "utf8" });
    expect(calls[1]!.body).toEqual({ path: "/tmp/tool", content: "AP8B/g==", encoding: "base64" });
    expect(calls[2]!.body).toEqual({ path: "/tmp/tool", mode: "755" });
    expect([...(await workspace.readBytes("/tmp/tool"))]).toEqual([...bytes]);
    expect(calls.at(-1)!.query.get("encoding")).toBe("base64");

    await expect(workspace.writeFiles([{ path: "/etc/passwd", content: "x" }])).rejects.toThrow("under /home/user or /tmp");
    await expect(workspace.writeFiles([{ path: "/home/user/../../etc/x", content: "x" }])).rejects.toThrow("under /home/user or /tmp");
    await expect(workspace.writeAgentFiles([{ name: "../escape", content: "x" }])).rejects.toThrow("Bad agent file name");
  });

  test("sends files over 5 MiB through a signed upload URL, and never names the URL in errors", async () => {
    const signed = "https://upload.boat.test/u/secret-signature";
    const big = new Uint8Array(5 * 1024 * 1024 + 1);
    const { workspace, calls } = await attached({
      "POST /sandboxes/bx_23456789/files/upload-url": json(200, { ok: true, url: signed, method: "PUT", path: "/home/user/bin/x", expiresAt: "2026-11-09T00:15:00Z" }),
      [`PUT ${new URL(signed).origin}/u/secret-signature`]: [new Response(null, { status: 200 }), new Response(null, { status: 500 })],
    });
    await workspace.writeFiles([{ path: "/home/user/bin/x", content: big }]);
    const upload = calls.at(-1)!;
    expect(upload.method).toBe("PUT");
    // Boat's key never goes to the signed URL.
    expect(upload.headers.get("authorization")).toBeNull();

    const failed = await workspace.writeFiles([{ path: "/home/user/bin/x", content: big }]).catch((error: Error) => error);
    expect(String(failed)).toContain("HTTP 500");
    expect(String(failed)).not.toContain("secret-signature");
  });
});

describe("TTL and usage", () => {
  test("extends the TTL and reads usage in seconds and dollars", async () => {
    const { workspace, calls } = await attached({
      "PATCH /sandboxes/bx_23456789": json(200, { ok: true, sandbox: sandbox("ready", { ttlSeconds: 3600 }) }),
      "GET /sandboxes/bx_23456789/usage": json(200, { ok: true, type: "sandbox.usage", sandboxId: ID, sandboxType: "default", billingMultiplier: 1, since: "x", until: "y", seconds: 4980, dollars: 0.0498, secondsPerDollar: 100000, running: true }),
    });
    await workspace.extendTtl(3600);
    expect(calls[0]).toMatchObject({ method: "PATCH", body: { ttlSeconds: 3600 } });
    expect(await workspace.usage()).toEqual({ seconds: 4980, usd: 0.0498, running: true });
    await expect(workspace.extendTtl(1.5)).rejects.toThrow("TTL");
  });
});

describe("destroy", () => {
  test("sends the confirmation header, treats a missing sandbox as deleted, and blocks further use", async () => {
    const { workspace, calls } = await attached({ "DELETE /sandboxes/bx_23456789": json(202, { ok: true, type: "sandbox.deleting", operation: { id: "bdop_x", status: "pending" } }) });
    await workspace.destroy();
    await workspace.destroy();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers.get("x-ascii-confirm-delete")).toBe(ID);
    await expect(workspace.exec(["true"])).rejects.toThrow("destroyed");

    const gone = await attached({ "DELETE /sandboxes/bx_23456789": apiError(404, "not_found") });
    await gone.workspace.destroy();
  });

  test("a failed delete can be retried", async () => {
    const { workspace, calls } = await attached({ "DELETE /sandboxes/bx_23456789": [apiError(409, "sandbox_securing"), json(202, { ok: true })] });
    await expect(workspace.destroy()).rejects.toThrow("Failed to delete sandbox");
    await workspace.destroy();
    expect(calls).toHaveLength(2);
  });
});

describe("retries", () => {
  test("idempotent calls retry 5xx and 429, honouring Retry-After", async () => {
    const boat = fakeBoat({
      "GET /sandboxes/bx_23456789": [apiError(503, "out_of_capacity"), apiError(429, "rate_limited", "slow down"), apiError(502, "http_502"), json(200, { ok: true, sandbox: sandbox("ready") })],
    });
    await BoatWorkspace.attach(ID, boat.options);
    expect(boat.count("GET /sandboxes/bx_23456789")).toBe(4);
  });

  test("a Retry-After beyond the limit fails at once instead of sleeping", async () => {
    const boat = fakeBoat({ "GET /sandboxes/bx_23456789": json(429, { ok: false, code: "limit_reached", message: "Too many sandboxes" }, { "retry-after": "3600" }) });
    await expect(BoatWorkspace.attach(ID, boat.options)).rejects.toThrow("429 limit_reached: Too many sandboxes");
    expect(boat.count("GET /sandboxes/bx_23456789")).toBe(1);
  });

  test("retries run out", async () => {
    const boat = fakeBoat({ "GET /sandboxes/bx_23456789": apiError(500, "http_500") });
    const error = await BoatWorkspace.attach(ID, { ...boat.options, retries: 2 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BoatApiError);
    expect((error as BoatApiError).status).toBe(500);
    expect(boat.count("GET /sandboxes/bx_23456789")).toBe(3);
  });

  test("network errors are retried for reads, never for commands", async () => {
    let reads = 0;
    const flaky = fakeBoat({
      "GET /sandboxes/bx_23456789": () => {
        if (reads++ === 0) throw new TypeError("connection reset");
        return json(200, { ok: true, sandbox: sandbox("ready") });
      },
    });
    await BoatWorkspace.attach(ID, flaky.options);
    expect(reads).toBe(2);

    const { workspace, count } = await attached({
      "POST /sandboxes/bx_23456789/commands": () => {
        throw new TypeError("connection reset");
      },
    });
    await expect(workspace.exec(["true"])).rejects.toThrow("network error");
    expect(count("POST /sandboxes/bx_23456789/commands")).toBe(1);
  });

  test("a command that may have run is never sent twice; one Boat proves never ran is", async () => {
    const { workspace, count } = await attached({
      "POST /sandboxes/bx_23456789/commands": [
        apiError(429, "IP_RATE_LIMIT_EXCEEDED"),
        apiError(409, "sandbox_starting"),
        apiError(502, "sandbox_direct_failed", "sandbox_restoring", { retryable: true, message: "sandbox_restoring" }),
        json(200, { ok: true, exitCode: 0, stdout: "", stderr: "", timedOut: false }),
        apiError(502, "sandbox_direct_failed", "machine did not answer", { retryable: false }),
        apiError(500, "http_500"),
      ],
    });
    expect((await workspace.exec(["true"])).exitCode).toBe(0);
    expect(count("POST /sandboxes/bx_23456789/commands")).toBe(4);
    await expect(workspace.exec(["true"])).rejects.toThrow("502 sandbox_direct_failed");
    await expect(workspace.exec(["true"])).rejects.toThrow("500 http_500");
    expect(count("POST /sandboxes/bx_23456789/commands")).toBe(6);
  });

  test("a create is retried with its idempotency key, and never without one", async () => {
    const keyed = fakeBoat({ "POST /sandboxes": [apiError(500, "http_500"), apiError(409, "idempotency_in_progress"), CREATED["POST /sandboxes"]], ...READY });
    await BoatWorkspace.create({ ...keyed.options, idempotencyKey: "scan-123-attempt-1" });
    const creates = keyed.calls.filter((c) => c.method === "POST");
    expect(creates).toHaveLength(3);
    for (const call of creates) expect(call.headers.get("idempotency-key")).toBe("scan-123-attempt-1");

    const unkeyed = fakeBoat({ "POST /sandboxes": [apiError(500, "http_500"), CREATED["POST /sandboxes"]] });
    const client = new BoatClient(unkeyed.options);
    await expect(client.createSandbox({ type: "small" })).rejects.toThrow("500 http_500");
    expect(unkeyed.count("POST /sandboxes")).toBe(1);
    expect(unkeyed.calls[0]!.headers.get("idempotency-key")).toBeNull();
  });

  test("every request has a timeout", async () => {
    // Never answers: only the request's own signal ends it.
    const hang = (call: Call) =>
      new Promise<Response>((_, reject) => {
        expect(call.signal).toBeDefined();
        call.signal!.addEventListener("abort", () => reject(call.signal!.reason));
      });
    const boat = fakeBoat({ "GET /sandboxes/bx_23456789": hang });
    await expect(BoatWorkspace.attach(ID, { ...boat.options, retries: 0, timeoutMs: 20 })).rejects.toThrow("GET /sandboxes/bx_23456789: timed out");
  });
});

describe("secrets", () => {
  test("the API key never appears in errors, even when the API echoes it", async () => {
    const boat = fakeBoat({
      "GET /sandboxes/bx_23456789": apiError(401, "unauthorized", `Key ${API_KEY} is not valid`),
      "POST /sandboxes/bx_23456789/commands": () => {
        throw new TypeError(`connect failed, Authorization: Bearer ${API_KEY}`);
      },
    });
    const errors: unknown[] = [];
    errors.push(await BoatWorkspace.attach(ID, boat.options).catch((e: unknown) => e));
    const client = new BoatClient(boat.options);
    errors.push(await client.runCommand(ID, "true", 1).catch((e: unknown) => e));
    for (const error of errors) {
      expect(error).toBeInstanceOf(WorkspaceError);
      const seen = JSON.stringify(error, Object.getOwnPropertyNames(error)) + String((error as Error).cause ?? "") + (error as Error).stack;
      expect(seen).not.toContain(API_KEY);
    }
  });
});

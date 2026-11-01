/**
 * Error reporting: DSN parsing, scrubbing, stack frames, and the whole path
 * to a fake Sentry endpoint on localhost, from the server and from the
 * browser snippet. No real DSN is ever used.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { envelope, exceptionValues, parseDsn, parseStack, routePattern, scrub } from "@/lib/sentry";
import { browserReporter } from "@/lib/sentry-browser";
import { config } from "@/server/config";
import { captureException, resetSentry, sentryEnabled } from "@/server/sentry";

/** Everything that must never reach Sentry, planted in one error. */
const SECRETS = {
  email: "jane.doe@example.com",
  token: "ghs_example0not0a0real0token",
  bearer: "Bearer abc.def.ghi-jkl",
  session: "Qm9vdHN0cmFwVG9rZW4xMjM0NTY3ODkw",
  ip: "203.0.113.7",
  home: "/Users/janedoe/projects/app",
  param: "SELECT * FROM invoices -- finding text",
};

function plantedError(): Error {
  const inner = new Error(`duplicate key: Key (email)=(${SECRETS.email}) already exists`);
  const error = new Error(
    `Failed query: select * from sessions where token = $1 at https://app.example.com/findings?repo=${SECRETS.session}&q=1 from ${SECRETS.ip} in ${SECRETS.home}, auth ${SECRETS.bearer} ${SECRETS.token} scan 0b5e9a6c-1f2d-4e3a-9b8c-7d6e5f4a3b2c\nparams: ${SECRETS.session},${SECRETS.param}`,
    { cause: inner },
  );
  error.stack = `Error: boom\n    at handler (/Users/janedoe/projects/app/apps/web/.next/server/chunks/ssr/page.js:12:34)\n    at async /Users/janedoe/projects/app/apps/web/.next/server/chunks/ssr/a1b2c3d4e5f6a7b8._.js:5:6\n    at async run (/Users/janedoe/projects/app/node_modules/next/dist/server.js:1:2)\n    at node:internal/process/task_queues:95:5`;
  return error;
}

function expectClean(text: string) {
  for (const value of Object.values(SECRETS)) expect(text).not.toContain(value);
  expect(text).not.toContain("janedoe");
}

describe("DSN", () => {
  test("parses Sentry DSNs, including a path prefix, and rejects anything else", () => {
    expect(parseDsn("https://abc123@o1.ingest.sentry.io/42")).toEqual({
      endpoint: "https://o1.ingest.sentry.io/api/42/envelope/?sentry_version=7&sentry_key=abc123&sentry_client=sandchest%2F1",
      dsn: "https://abc123@o1.ingest.sentry.io/42",
    });
    expect(parseDsn("http://key@127.0.0.1:9000/relay/7")?.endpoint).toStartWith("http://127.0.0.1:9000/relay/api/7/envelope/?");
    for (const bad of [undefined, "", "not a url", "https://o1.ingest.sentry.io/42", "https://key@host/project", "ftp://key@host/1", "javascript://key@x/1"]) expect(parseDsn(bad)).toBeUndefined();
  });

  test("a deployment with a malformed DSN is told so at start-up", () => {
    const base = { DATABASE_URL: "postgres://x", GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: "k", GITHUB_WEBHOOK_SECRET: "s", SANDCHEST_APP_URL: "https://sandchest.test" };
    expect(() => config({ ...base, SENTRY_DSN: "not a url" })).toThrow(/SENTRY_DSN/);
    expect(() => config({ ...base, NEXT_PUBLIC_SENTRY_DSN: "not a url" })).toThrow(/NEXT_PUBLIC_SENTRY_DSN/);
    expect(config({ ...base, SENTRY_DSN: "https://k@o1.ingest.sentry.io/1" }).SENTRY_DSN).toBe("https://k@o1.ingest.sentry.io/1");
  });
});

describe("scrubbing", () => {
  test("removes emails, tokens, query strings, addresses, home directories and query parameters", () => {
    const values = exceptionValues(plantedError(), { type: "test", handled: false });
    const text = JSON.stringify(values);
    expectClean(text);
    // What stays: the shape of the error, opaque ids and our own frames.
    expect(text).toContain("Failed query: select * from sessions where token = $1");
    expect(text).toContain("0b5e9a6c-1f2d-4e3a-9b8c-7d6e5f4a3b2c");
    expect(text).toContain("https://app.example.com/findings?[query]");
    expect(text).toContain("params: [redacted]");
    expect(values).toHaveLength(2);
    expect(values[0]!.value).toBe("duplicate key: Key (email)=([redacted]) already exists");
  });

  test("thrown non-errors report only their type", () => {
    expect(exceptionValues({ password: "hunter2" }, { type: "test", handled: false })).toEqual([{ type: "NonError", value: "Non-error value thrown: object", mechanism: { type: "test", handled: false } }]);
    expect(JSON.stringify(exceptionValues("secret string", { type: "t", handled: true }))).not.toContain("secret string");
  });

  test("long messages are cut after scrubbing", () => {
    expect(scrub("x".repeat(5_000))).toHaveLength(1_001);
  });

  test("stack frames keep the build path only, oldest call first", () => {
    const frames = parseStack(plantedError().stack);
    expect(frames.map((frame) => frame.filename)).toEqual([
      "node:internal/process/task_queues",
      "app:///node_modules/next/dist/server.js",
      // An anonymous async frame: "at async <file>", no function name.
      "app:///.next/server/chunks/ssr/a1b2c3d4e5f6a7b8._.js",
      "app:///.next/server/chunks/ssr/page.js",
    ]);
    expect(frames[2]!.function).toBeUndefined();
    expect(frames.at(-1)).toEqual({ filename: "app:///.next/server/chunks/ssr/page.js", function: "handler", lineno: 12, colno: 34, in_app: true });
    expect(frames[1]!.in_app).toBe(false);
    const gecko = parseStack("render@https://sandchest.test/_next/static/chunks/app.js?v=1:3:9\n@https://cdn.example.com/x.js:1:1", "https://sandchest.test");
    expect(gecko.map((frame) => frame.filename)).toEqual(["https://cdn.example.com/x.js", "app:///_next/static/chunks/app.js"]);
  });

  test("route patterns hide ids", () => {
    expect(routePattern("/findings/0b5e9a6c-1f2d-4e3a-9b8c-7d6e5f4a3b2c?tab=1")).toBe("/findings/[id]");
    expect(routePattern("/repos/123456/x")).toBe("/repos/[id]/x");
  });
});

// ---- A fake Sentry on localhost ------------------------------------------------

let server: ReturnType<typeof Bun.serve>;
const received: Array<{ url: string; headers: Headers; body: string }> = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      received.push({ url: request.url, headers: request.headers, body: await request.text() });
      return new Response("{}", { headers: { "access-control-allow-origin": "*" } });
    },
  });
});

afterAll(() => {
  server.stop(true);
  delete process.env.SENTRY_DSN;
  resetSentry();
});

beforeEach(() => {
  received.length = 0;
  resetSentry();
  delete process.env.SENTRY_DSN;
});

function parse(body: string) {
  const [header, item, event] = body.trim().split("\n").map((line) => JSON.parse(line));
  return { header, item, event };
}

describe("server reporting", () => {
  test("without a DSN nothing is sent", async () => {
    expect(sentryEnabled()).toBe(false);
    await captureException(plantedError(), { source: "request" });
    expect(received).toHaveLength(0);
  });

  test("sends one scrubbed envelope per distinct error, with no request, user or breadcrumbs", async () => {
    process.env.SENTRY_DSN = `http://publickey@127.0.0.1:${server.port}/5`;
    await captureException(plantedError(), { source: "request", tags: { route: "/findings/[id]", route_type: "render", method: "GET", digest: "12345" } });
    // The same error again within a minute is dropped.
    await captureException(plantedError(), { source: "request" });
    expect(received).toHaveLength(1);
    const [request] = received;
    expect(request!.url).toBe(`http://127.0.0.1:${server.port}/api/5/envelope/?sentry_version=7&sentry_key=publickey&sentry_client=sandchest%2F1`);
    expect(request!.headers.get("cookie")).toBeNull();
    expectClean(request!.body);
    const { header, item, event } = parse(request!.body);
    expect(header.event_id).toBe(event.event_id);
    expect(item).toEqual({ type: "event" });
    expect(Object.keys(event).sort()).toEqual(["environment", "event_id", "exception", "level", "platform", "sdk", "tags", "timestamp"]);
    expect(event).toMatchObject({ platform: "node", level: "error", tags: { source: "request", route: "/findings/[id]", route_type: "render", method: "GET", digest: "12345" } });
    expect(event.exception.values.at(-1).stacktrace.frames.at(-1).filename).toBe("app:///.next/server/chunks/ssr/page.js");
  });

  test("caps a burst of different errors", async () => {
    process.env.SENTRY_DSN = `http://publickey@127.0.0.1:${server.port}/5`;
    for (let i = 0; i < 50; i++) await captureException(new Error(`error number ${i}`), { source: "workflow", tags: { step: "execute" }, handled: true });
    expect(received).toHaveLength(30);
    expect(parse(received[0]!.body).event.level).toBe("warning");
  });

  test("a withheld message sends the type and stack only", async () => {
    process.env.SENTRY_DSN = `http://publickey@127.0.0.1:${server.port}/5`;
    await captureException(new Error("550 mailbox unavailable for someone"), { source: "notifications", handled: true, withholdMessage: true });
    const { event } = parse(received[0]!.body);
    expect(event.exception.values[0]).toMatchObject({ type: "Error", value: "(message withheld)" });
    expect(received[0]!.body).not.toContain("mailbox");
  });

  test("an unreachable endpoint never throws", async () => {
    process.env.SENTRY_DSN = "http://publickey@127.0.0.1:9/5";
    await captureException(new Error("x"), { source: "request" });
  });
});

describe("browser reporting", () => {
  test("no public DSN, no script", () => {
    expect(browserReporter({})).toBeUndefined();
    expect(browserReporter({ dsn: "not a dsn" })).toBeUndefined();
  });

  test("the script cannot break out of its tag", () => {
    const script = browserReporter({ dsn: "https://k@o1.ingest.sentry.io/1", environment: "</script><script>alert(1)</script>" })!;
    expect(script).not.toContain("</script>");
    expect(script.length).toBeLessThan(4_000);
  });

  test("reports an uncaught error and an unhandled rejection to the endpoint, scrubbed", async () => {
    const script = browserReporter({ dsn: `http://publickey@127.0.0.1:${server.port}/5`, environment: "test", release: "abcdef1234567890" })!;
    // A minimal window: the snippet only uses these.
    const listeners: Record<string, (event: unknown) => void> = {};
    const window = {
      location: { origin: "https://sandchest.test", pathname: "/findings/0b5e9a6c-1f2d-4e3a-9b8c-7d6e5f4a3b2c", href: "https://sandchest.test/findings/0b5e9a6c-1f2d-4e3a-9b8c-7d6e5f4a3b2c?q=secret" },
      addEventListener: (type: string, listener: (event: unknown) => void) => (listeners[type] = listener),
      fetch: (url: string, init: RequestInit) => fetch(url, init),
      crypto,
    };
    new Function("location", "addEventListener", "fetch", "crypto", script)(window.location, window.addEventListener, window.fetch, window.crypto);

    const error = plantedError();
    error.stack = `Error: boom\n    at onClick (https://sandchest.test/_next/static/chunks/app.js?v=2:1:900)\n    at https://extension.example/inject.js:4:4`;
    listeners.error!({ error, message: error.message });
    listeners.error!({ error, message: error.message }); // a repeat is dropped
    listeners.error!({ error: null, message: "Script error." }); // cross-origin noise is dropped
    listeners.unhandledrejection!({ reason: { secret: SECRETS.email } });
    await Bun.sleep(100);

    expect(received).toHaveLength(2);
    for (const request of received) expectClean(request.body);
    const first = parse(received[0]!.body).event;
    expect(first).toMatchObject({ platform: "javascript", environment: "test", release: "abcdef123456", tags: { source: "browser", page: "/findings/[id]" } });
    expect(Object.keys(first).sort()).toEqual(["environment", "event_id", "exception", "level", "platform", "release", "sdk", "tags", "timestamp"]);
    const frames = first.exception.values.at(-1).stacktrace.frames;
    expect(frames.map((frame: { filename: string; in_app: boolean }) => [frame.filename, frame.in_app])).toEqual([
      ["https://extension.example/inject.js", false],
      ["app:///_next/static/chunks/app.js", true],
    ]);
    expect(parse(received[1]!.body).event.exception.values).toEqual([{ type: "NonError", value: "Non-error value thrown: object", mechanism: { type: "onunhandledrejection", handled: false } }]);
  });

  test("the browser and server scrub the same way", async () => {
    const script = browserReporter({ dsn: `http://publickey@127.0.0.1:${server.port}/5` })!;
    let sent = "";
    const listeners: Record<string, (event: unknown) => void> = {};
    new Function("location", "addEventListener", "fetch", "crypto", script)(
      { origin: "https://sandchest.test", pathname: "/" },
      (type: string, listener: (event: unknown) => void) => (listeners[type] = listener),
      async (_url: string, init: RequestInit) => {
        sent = String(init.body);
        return new Response();
      },
      crypto,
    );
    const error = plantedError();
    error.stack = undefined;
    listeners.error!({ error });
    const browser = parse(sent).event.exception.values.map((value: { value: string }) => value.value);
    expect(browser).toEqual(exceptionValues(error, { type: "x", handled: false }).map((value) => value.value));
  });

  test("an envelope is three JSON lines", () => {
    const dsn = parseDsn("https://k@o1.ingest.sentry.io/1")!;
    const body = envelope({ event_id: "a".repeat(32), timestamp: 1, platform: "node", level: "error", exception: { values: [] }, tags: {}, sdk: { name: "x", version: "1" } }, dsn, new Date(0));
    expect(body.split("\n")).toHaveLength(4);
    expect(parse(body).header).toEqual({ event_id: "a".repeat(32), sent_at: "1970-01-01T00:00:00.000Z", dsn: "https://k@o1.ingest.sentry.io/1" });
  });
});

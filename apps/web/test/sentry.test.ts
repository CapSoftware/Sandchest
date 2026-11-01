/**
 * Error reporting: DSN parsing, scrubbing, stack frames, and the whole path
 * to a fake Sentry endpoint on localhost, from the server and from the
 * browser snippet. No real DSN is ever used.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { envelope, errorType, exceptionValues, PAGE_TEMPLATES, pageTemplate, parseDsn, parseStack, SAFE_MESSAGES, safeMessage, scrub, WITHHELD } from "@/lib/sentry";
import { browserReporter } from "@/lib/sentry-browser";
import { config, resetConfig } from "@/server/config";
import { captureException, methodTag, resetSentry, sentryEnabled, webhookEventTag } from "@/server/sentry";

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

  test("a DSN whose key is not valid percent-encoding turns reporting off instead of throwing", async () => {
    const bad = "https://%E0%A4%A@o1.ingest.sentry.io/1";
    expect(() => parseDsn(bad)).not.toThrow();
    expect(parseDsn(bad)).toBeUndefined();
    // Every page renders this: a bad public DSN must not turn them all into errors.
    expect(browserReporter({ dsn: bad })).toBeUndefined();
    // The server path runs inside error handlers: the original error must stay the one that surfaces.
    process.env.SENTRY_DSN = bad;
    resetSentry();
    expect(sentryEnabled()).toBe(false);
    await captureException(new Error("x"), { source: "workflow" });
    delete process.env.SENTRY_DSN;
    resetSentry();
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
    // What stays: the text of our own query (never its parameters), opaque ids and our own frames.
    expect(text).toContain("Failed query: select * from sessions where token = $1");
    expect(text).toContain("0b5e9a6c-1f2d-4e3a-9b8c-7d6e5f4a3b2c");
    expect(text).toContain("https://app.example.com/findings?[query]");
    expect(text).not.toContain("params");
    expect(values).toHaveLength(2);
    // The cause has no known-safe shape, so its message is not sent at all.
    expect(values[0]!.value).toBe(WITHHELD);
  });

  test("messages without a known-safe shape are withheld: scan errors quote repositories, refs and paths", () => {
    for (const message of [
      "Command failed: git clone --depth=1 https://github.com/acme/app.git\nfatal: repository 'https://github.com/acme/app.git/' not found",
      "Invalid ref: feature/acme-billing",
      "File not found: src/billing/invoices.ts",
      "Path escapes the checkout: ../../etc/passwd",
      "GitHub API 404 on /repos/acme/app/pulls/12/files",
      "Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON",
    ])
      expect(safeMessage(message)).toBe(WITHHELD);
    // Shapes that carry no customer data still help.
    expect(safeMessage("Cannot read properties of undefined (reading 'id')")).toBe("Cannot read properties of undefined (reading <property>)");
    expect(safeMessage('relation "scan_metrics" does not exist')).toBe('relation "scan_metrics" does not exist');
    expect(safeMessage("Scan 0b5e9a6c-1f2d-4e3a-9b8c-7d6e5f4a3b2c not found")).toBe("Scan 0b5e9a6c-1f2d-4e3a-9b8c-7d6e5f4a3b2c not found");
    // A safe prefix with something after it keeps only the prefix.
    expect(safeMessage("Minified React error #418; visit https://react.dev/errors/418?args[]=acme")).toBe("Minified React error #418");
    expect(safeMessage(undefined)).toBe(WITHHELD);
  });

  test("known-safe shapes send only their static text: no hosts, addresses, ports, databases or roles", () => {
    const cases: Array<[string, string]> = [
      ["getaddrinfo ENOTFOUND acme-private-db.example.com", "getaddrinfo ENOTFOUND"],
      ["getaddrinfo EAI_AGAIN db.internal.acme.example", "getaddrinfo EAI_AGAIN"],
      ["connect ECONNREFUSED 10.0.0.5:5432", "connect ECONNREFUSED"],
      ["connect ECONNREFUSED ::1:5432", "connect ECONNREFUSED"],
      ["connect ETIMEDOUT [2001:db8::42]:6432", "connect ETIMEDOUT"],
      ["read ECONNRESET acme-pooler.example.com:6432", "read ECONNRESET"],
      ['role "acme_admin" does not exist', "role does not exist"],
      ['database "acme_production" does not exist', "database does not exist"],
      ['password authentication failed for user "acme_app"', "password authentication failed"],
      ['too many connections for role "acme_app"', "too many connections for role"],
      ["Invalid server configuration:\n  DATABASE_URL: Invalid input", "Invalid server configuration"],
      ["Minified React error #418; visit https://react.dev/errors/418?args[]=acme", "Minified React error #418"],
      ["null is not an object (evaluating 'jane.doe@example.com')", "null is not an object"],
    ];
    for (const [message, sent] of cases) expect(safeMessage(message)).toBe(sent);
    // Identifier slots take identifier characters only: anything else is withheld.
    // Code can name a property after data: the name is replaced, whatever it is.
    expect(safeMessage("Cannot read properties of undefined (reading 'AcmeCorp')")).toBe("Cannot read properties of undefined (reading <property>)");
    expect(safeMessage("Cannot read properties of null (reading 'jane.doe@example.com')")).toBe("Cannot read properties of null (reading <property>)");
    expect(safeMessage("Cannot set property 'AcmeCorp' of undefined")).toBe("Cannot set property <property> of undefined");
    expect(safeMessage("acmeCustomer.render is not a function")).toBe("<expression> is not a function");
    expect(safeMessage("jane.doe@example.com is not a function")).toBe(WITHHELD);
    expect(safeMessage('relation "acme customers; drop" does not exist')).toBe(WITHHELD);
  });

  test("the page is a known route template or unknown, never the raw path", () => {
    expect(pageTemplate("/findings/0b5e9a6c-1f2d-4e3a-9b8c-7d6e5f4a3b2c")).toBe("/findings/[id]");
    expect(pageTemplate("/scans/0b5e9a6c-1f2d-4e3a-9b8c-7d6e5f4a3b2c")).toBe("/scans/[id]");
    expect(pageTemplate("/repos")).toBe("/repos");
    for (const path of ["/findings/jane.doe@example.com", "/findings/0b5e9a6c-1f2d-4e3a-9b8c-7d6e5f4a3b2c/x", "/acme-secret-project", "/repos/123456"]) expect(pageTemplate(path)).toBe("unknown");
    // Operator pages are never named in what the browser carries.
    expect(JSON.stringify(PAGE_TEMPLATES)).not.toMatch(/admin|ops/);
  });

  test("scrubbing and message checks stay fast on huge or hostile input", () => {
    const hostile = [
      "a".repeat(100_000),
      "a.".repeat(50_000),
      `${"a".repeat(99_000)}@`,
      "1".repeat(100_000),
      "aB3".repeat(33_000),
      `${"x@".repeat(50_000)}`,
      `https://${"a".repeat(100_000)}`,
      `at ${"(".repeat(50_000)}`,
    ];
    for (const input of hostile) {
      const started = performance.now();
      scrub(input);
      safeMessage(input);
      parseStack(`Error\n${input}\n    at f (/x/.next/a.js:1:1)`);
      const error = new Error(input);
      error.stack = `Error: ${input}`;
      exceptionValues(error, { type: "t", handled: false });
      expect(performance.now() - started).toBeLessThan(50);
    }
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
    // Where, never what: no function name, even when the frame has one ("handler").
    expect(frames.at(-1)).toEqual({ filename: "app:///.next/server/chunks/ssr/page.js", lineno: 12, colno: 34, in_app: true });
    expect(frames[1]!.in_app).toBe(false);
    // Other server files (a path with someone's name in it) are dropped, not scrubbed.
    expect(parseStack("Error\n    at f (/home/jane.doe/acme/tool.js:1:1)\n    at g (/var/task/apps/web/.next/server/a.js:2:2)").map((frame) => frame.filename)).toEqual(["app:///.next/server/a.js"]);
  });

  test("browser frames keep only our own static assets", () => {
    const stack = [
      "render@https://sandchest.test/_next/static/chunks/app.js?v=1:3:9",
      "@https://cdn.example.com/x.js:1:1",
      "inline@https://sandchest.test/findings/jane.doe@example.com:4:4",
      "ext@chrome-extension://abc/inject.js:5:5",
      "tricky@https://sandchest.test.evil.example/_next/static/chunks/a.js:6:6",
    ].join("\n");
    expect(parseStack(stack, "https://sandchest.test").map((frame) => frame.filename)).toEqual(["app:///_next/static/chunks/app.js"]);
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

describe("names", () => {
  test("error types are known classes or plain Error", () => {
    for (const name of ["TypeError", "GitHubError", "LlmQuotaError", "PostgresError", "AbortError"]) expect(errorType(name)).toBe(name);
    for (const name of ["CustomerAcme_123", "jane.doe@example.com", "", undefined, 42]) expect(errorType(name)).toBe("Error");
    const error = new Error("x");
    error.name = "CustomerAcme_123";
    expect(exceptionValues(error, { type: "t", handled: false })[0]!.type).toBe("Error");
  });

  test("frames carry no function names", () => {
    const frames = parseStack("Error\n    at jane.doe@example.com (/srv/app/.next/server/a.js:1:2)\n    at AcmeCorp.render (/srv/app/.next/server/b.js:3:4)");
    expect(JSON.stringify(frames)).not.toMatch(/jane|Acme/);
    expect(frames).toEqual([
      { filename: "app:///.next/server/b.js", lineno: 3, colno: 4, in_app: true },
      { filename: "app:///.next/server/a.js", lineno: 1, colno: 2, in_app: true },
    ]);
  });

  test("webhook events and request methods are named only when known", () => {
    expect(webhookEventTag("pull_request")).toBe("pull_request");
    expect(webhookEventTag("installation_repositories")).toBe("installation_repositories");
    for (const event of ["CustomerAcme_123", "", null, undefined]) expect(webhookEventTag(event)).toBe("unknown");
    expect(methodTag("POST")).toBe("POST");
    expect(methodTag("ACME_CUSTOMER")).toBe("other");
  });

  test("every safe message shape, fed hostile values, sends only static text or our own schema", () => {
    // One example per shape. "Acme" marks a value that must not survive; schema names, our SQL and scan ids may.
    const examples: Array<[string, string]> = [
      ["Cannot read properties of undefined (reading 'AcmeCorp')", "Cannot read properties of undefined (reading <property>)"],
      ["Cannot set property 'AcmeCorp' of null", "Cannot set property <property> of null"],
      ["AcmeCorp.render is not a function", "<expression> is not a function"],
      ["undefined is not an object (evaluating 'AcmeCorp.id')", "undefined is not an object"],
      ["Maximum call stack size exceeded", "Maximum call stack size exceeded"],
      ["Unexpected end of JSON input", "Unexpected end of JSON input"],
      ["Minified React error #31; visit https://react.dev/errors/31?args[]=AcmeCorp", "Minified React error #31"],
      ["Hydration failed because the server rendered AcmeCorp", "Hydration failed"],
      ["Failed to fetch", "Failed to fetch"],
      ["connect ECONNREFUSED acme-db.example.com:5432", "connect ECONNREFUSED"],
      ["getaddrinfo ENOTFOUND acme-db.example.com", "getaddrinfo ENOTFOUND"],
      ["Failed query: select id from scans where org_id = $1\nparams: AcmeCorp", "Failed query: select id from scans where org_id = $1"],
      ['duplicate key value violates unique constraint "scans_pr_head_unique"', 'duplicate key value violates unique constraint "scans_pr_head_unique"'],
      ['relation "scan_metrics" does not exist', 'relation "scan_metrics" does not exist'],
      ['role "acme_admin" does not exist', "role does not exist"],
      ['password authentication failed for user "acme"', "password authentication failed"],
      ['too many connections for role "acme"', "too many connections for role"],
      ["deadlock detected", "deadlock detected"],
      ["Scan 0b5e9a6c-1f2d-4e3a-9b8c-7d6e5f4a3b2c not found", "Scan 0b5e9a6c-1f2d-4e3a-9b8c-7d6e5f4a3b2c not found"],
      ["Invalid server configuration:\n  ACME_SECRET: bad", "Invalid server configuration"],
    ];
    for (const [message, sent] of examples) {
      expect(safeMessage(message)).toBe(sent);
      expect(safeMessage(message)).not.toMatch(/acme/i);
    }
    // Every shape is exercised, so a new one cannot slip in untested.
    for (const [pattern, flags] of SAFE_MESSAGES) expect({ pattern, covered: examples.some(([message]) => new RegExp(pattern, flags).test(message)) }).toEqual({ pattern, covered: true });
  });
});

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

  test("a scan's failure goes with its step and opaque scan id, never its message", async () => {
    process.env.SENTRY_DSN = `http://publickey@127.0.0.1:${server.port}/5`;
    const error = new Error("Command failed: git clone https://github.com/acme/app.git\nfatal: repository 'https://github.com/acme/app.git/' not found");
    await captureException(error, { source: "workflow", tags: { step: "execute", scan_id: "0b5e9a6c-1f2d-4e3a-9b8c-7d6e5f4a3b2c" } });
    expect(received).toHaveLength(1);
    expect(received[0]!.body).not.toContain("acme");
    const { event } = parse(received[0]!.body);
    expect(event.exception.values[0].value).toBe(WITHHELD);
    expect(event.tags).toMatchObject({ source: "workflow", step: "execute", scan_id: "0b5e9a6c-1f2d-4e3a-9b8c-7d6e5f4a3b2c" });
  });

  test("caps a burst of different errors", async () => {
    process.env.SENTRY_DSN = `http://publickey@127.0.0.1:${server.port}/5`;
    for (let i = 0; i < 50; i++) {
      // Different errors: messages are withheld, so they differ by where they were thrown.
      const error = new Error(`error number ${i}`);
      error.stack = `Error: error number ${i}\n    at step (/srv/app/.next/server/chunks/scan.js:${i + 1}:1)`;
      await captureException(error, { source: "workflow", tags: { step: "execute" }, handled: true });
    }
    expect(received).toHaveLength(30);
    expect(parse(received[0]!.body).event.level).toBe("warning");
  });

  test("a mail failure sends its type and stack only, since mail errors quote addresses", async () => {
    process.env.SENTRY_DSN = `http://publickey@127.0.0.1:${server.port}/5`;
    await captureException(new Error("550 mailbox unavailable for someone"), { source: "notifications", handled: true });
    const { event } = parse(received[0]!.body);
    expect(event.exception.values[0]).toMatchObject({ type: "Error", value: "(message withheld)" });
    expect(received[0]!.body).not.toContain("mailbox");
  });

  test("a failing webhook is tagged with a known event name, never the sender's header", async () => {
    const saved = { ...process.env };
    Object.assign(process.env, {
      DATABASE_URL: "postgresql://sandchest:sandchest@127.0.0.1:5432/unused",
      GITHUB_APP_ID: "1",
      GITHUB_APP_PRIVATE_KEY: "unused",
      GITHUB_WEBHOOK_SECRET: "webhook-secret",
      SANDCHEST_APP_URL: "https://sandchest.test",
      SENTRY_DSN: `http://publickey@127.0.0.1:${server.port}/5`,
    });
    resetConfig();
    resetSentry();
    try {
      const { POST } = await import("@/app/api/github/webhooks/route");
      const body = "not json";
      const signature = `sha256=${createHmac("sha256", "webhook-secret").update(body).digest("hex")}`;
      // A signed delivery whose body fails to parse, with an event header the sender made up.
      const response = await POST(new Request("https://sandchest.test/api/github/webhooks", { method: "POST", body, headers: { "x-hub-signature-256": signature, "x-github-event": "CustomerAcme_123", "x-github-delivery": "d-1" } }));
      expect(response.status).toBe(500);
      expect(received).toHaveLength(1);
      expect(received[0]!.body).not.toContain("Acme");
      expect(parse(received[0]!.body).event.tags).toMatchObject({ source: "webhook", event: "unknown" });
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
      resetConfig();
    }
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
    expect(script.length).toBeLessThan(7_000);
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
    // The extension's frame is dropped: only our own static assets are kept.
    expect(frames.map((frame: { filename: string; in_app: boolean }) => [frame.filename, frame.in_app])).toEqual([["app:///_next/static/chunks/app.js", true]]);
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

  test("a browser report from a path that names someone says only 'unknown'", () => {
    const script = browserReporter({ dsn: "http://publickey@127.0.0.1:9/5" })!;
    const listeners: Record<string, (event: unknown) => void> = {};
    let body = "";
    new Function("location", "addEventListener", "fetch", "crypto", script)(
      { origin: "https://sandchest.test", pathname: "/findings/jane.doe@example.com" },
      (type: string, listener: (event: unknown) => void) => (listeners[type] = listener),
      async (_url: string, init: RequestInit) => {
        body = String(init.body);
        return new Response();
      },
      crypto,
    );
    const error = new Error("boom");
    error.stack = "Error: boom\n    at x (https://sandchest.test/findings/jane.doe@example.com:1:1)\n    at y (https://sandchest.test/_next/static/chunks/app.js:2:2)";
    listeners.error!({ error });
    expect(body).not.toContain("jane");
    const { event } = parse(body);
    expect(event.tags.page).toBe("unknown");
    expect(event.exception.values[0].stacktrace.frames.map((frame: { filename: string }) => frame.filename)).toEqual(["app:///_next/static/chunks/app.js"]);
  });

  test("a browser report names neither an unknown error type nor any function", () => {
    const script = browserReporter({ dsn: "http://publickey@127.0.0.1:9/5" })!;
    const listeners: Record<string, (event: unknown) => void> = {};
    let body = "";
    new Function("location", "addEventListener", "fetch", "crypto", script)(
      { origin: "https://sandchest.test", pathname: "/repos" },
      (type: string, listener: (event: unknown) => void) => (listeners[type] = listener),
      async (_url: string, init: RequestInit) => {
        body = String(init.body);
        return new Response();
      },
      crypto,
    );
    const error = new Error("Cannot read properties of undefined (reading 'AcmeCorp')");
    error.name = "CustomerAcme_123";
    error.stack = "Error\n    at jane.doe@example.com (https://sandchest.test/_next/static/chunks/app.js:2:2)";
    listeners.error!({ error });
    expect(body).not.toMatch(/Acme|jane/);
    const value = parse(body).event.exception.values[0];
    expect(value.type).toBe("Error");
    expect(value.value).toBe("Cannot read properties of undefined (reading <property>)");
    expect(value.stacktrace.frames).toEqual([{ filename: "app:///_next/static/chunks/app.js", lineno: 2, colno: 2, in_app: true }]);
    const typed = new TypeError("x");
    typed.stack = "TypeError: x\n    at f (https://sandchest.test/_next/static/chunks/b.js:1:1)";
    listeners.error!({ error: typed });
    expect(parse(body).event.exception.values[0].type).toBe("TypeError");
  });

  test("the browser reporter stays fast on a huge message", () => {
    const script = browserReporter({ dsn: "http://publickey@127.0.0.1:9/5" })!;
    const listeners: Record<string, (event: unknown) => void> = {};
    let body = "";
    new Function("location", "addEventListener", "fetch", "crypto", script)(
      { origin: "https://sandchest.test", pathname: "/" },
      (type: string, listener: (event: unknown) => void) => (listeners[type] = listener),
      async (_url: string, init: RequestInit) => {
        body = String(init.body);
        return new Response();
      },
      crypto,
    );
    const error = new Error(`${"a".repeat(99_000)}@`);
    error.stack = `Error: ${"a.".repeat(50_000)}\n    at f (https://sandchest.test/_next/static/chunks/app.js:1:1)`;
    const started = performance.now();
    listeners.error!({ error });
    expect(performance.now() - started).toBeLessThan(50);
    expect(parse(body).event.exception.values[0].value).toBe(WITHHELD);
  });

  test("an envelope is three JSON lines", () => {
    const dsn = parseDsn("https://k@o1.ingest.sentry.io/1")!;
    const body = envelope({ event_id: "a".repeat(32), timestamp: 1, platform: "node", level: "error", exception: { values: [] }, tags: {}, sdk: { name: "x", version: "1" } }, dsn, new Date(0));
    expect(body.split("\n")).toHaveLength(4);
    expect(parse(body).header).toEqual({ event_id: "a".repeat(32), sent_at: "1970-01-01T00:00:00.000Z", dsn: "https://k@o1.ingest.sentry.io/1" });
  });
});

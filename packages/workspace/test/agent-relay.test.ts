/** The relay that carries the agent's model calls to the gateway, run as a real child process against a local fake. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WorkspaceError } from "../src";
import { AGENT_RELAY_MAX_BODY, agentRelayCommand } from "../src/agent-relay";

const TOKEN = "relay-test-token-0123456789";
const runtime = Bun.which("node") ?? process.execPath;

interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

let upstream: Server;
let upstreamPort: number;
const seen: Seen[] = [];
let release: () => void = () => {};

let relay: ReturnType<typeof Bun.spawn>;
let relayPort: number;
let relayLog = "";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startRelay(port: number, targetUrl: string) {
  const { cmd, env } = agentRelayCommand({ port, targetUrl, token: TOKEN });
  const child = Bun.spawn([runtime, ...cmd.slice(1)], { env: { PATH: process.env.PATH ?? "", ...env }, stdout: "pipe", stderr: "pipe" });
  const reader = child.stdout.getReader();
  let out = "";
  while (!out.includes("listening")) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`relay exited: ${await new Response(child.stderr).text()}`);
    out += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  return { child, out };
}

/** A raw request, so headers, chunked bodies and partial reads are under the test's control. */
function send(
  port: number,
  options: { method?: string; path?: string; headers?: Record<string, string>; body?: string | Buffer | Buffer[]; onFirstChunk?: (chunk: string) => void },
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method: options.method ?? "POST", path: options.path ?? "/v1/messages", headers: options.headers }, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => {
        if (!body) options.onFirstChunk?.(chunk.toString());
        body += chunk.toString();
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      res.on("error", reject);
    });
    req.on("error", reject);
    const parts = Array.isArray(options.body) ? options.body : options.body === undefined ? [] : [options.body];
    for (const part of parts) req.write(part);
    req.end();
  });
}

beforeAll(async () => {
  upstream = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      if (req.url?.includes("slow=1")) {
        res.writeHead(200, { "content-type": "text/event-stream", "x-upstream-only": "1" });
        res.write("event: message_start\ndata: {}\n\n");
        release = () => res.end("event: message_stop\ndata: {}\n\n");
        return;
      }
      res.writeHead(429, { "content-type": "application/json", "retry-after": "7", "x-upstream-only": "1", "set-cookie": "a=b" });
      res.end(JSON.stringify({ echo: body.length }));
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  upstreamPort = (upstream.address() as AddressInfo).port;
  relayPort = await freePort();
  const started = await startRelay(relayPort, `http://127.0.0.1:${upstreamPort}/api/gateway/`);
  relay = started.child;
  relayLog = started.out;
});

afterAll(async () => {
  relay?.kill();
  await new Promise((resolve) => upstream?.close(resolve));
});

describe("agentRelayCommand", () => {
  test("puts the settings in the environment, never on the command line", () => {
    const { cmd, env } = agentRelayCommand({ port: 4100, targetUrl: "https://gateway.example.com/api/gateway", token: TOKEN });
    expect(cmd[0]).toBe("node");
    expect(cmd.join(" ")).not.toContain(TOKEN);
    expect(Object.values(env)).toContain(TOKEN);
    expect(Object.values(env)).toContain("https://gateway.example.com/api/gateway");
  });

  test("refuses settings that are not a loopback relay to an http(s) gateway", () => {
    const bad = [
      { port: 0, targetUrl: "http://127.0.0.1:1", token: TOKEN },
      { port: 70_000, targetUrl: "http://127.0.0.1:1", token: TOKEN },
      { port: 4100, targetUrl: "file:///etc/passwd", token: TOKEN },
      { port: 4100, targetUrl: "not a url", token: TOKEN },
      { port: 4100, targetUrl: "https://u:p@gateway.example.com", token: TOKEN },
      { port: 4100, targetUrl: "https://gateway.example.com/?x=1", token: TOKEN },
      { port: 4100, targetUrl: "https://gateway.example.com", token: "" },
      { port: 4100, targetUrl: "https://gateway.example.com", token: "a\r\nx-evil: 1" },
    ];
    for (const settings of bad) expect(() => agentRelayCommand(settings)).toThrow(WorkspaceError);
  });
});

describe("relay", () => {
  test("answers 404 to anything but POST /v1/messages, without contacting the target", async () => {
    const before = seen.length;
    for (const [method, path] of [
      ["GET", "/v1/messages"],
      ["POST", "/v1/messages/count_tokens"],
      ["POST", "/v1/models"],
      ["POST", "/"],
      ["POST", "/v1/messages/"],
      ["PUT", "/v1/messages"],
    ] as const) {
      expect((await send(relayPort, { method, path, body: "{}" })).status).toBe(404);
    }
    expect(seen.length).toBe(before);
  });

  test("forwards the body and query with only its own authorization and the content type", async () => {
    const body = JSON.stringify({ model: "x", messages: [{ role: "user", content: "hi" }] });
    const res = await send(relayPort, {
      path: "/v1/messages?beta=true",
      headers: { "content-type": "application/json", authorization: "Bearer agent-placeholder", "x-api-key": "agent-key", "x-custom": "1", cookie: "c=d" },
      body,
    });
    // Status, content type and retry-after come back; nothing else from upstream does.
    expect(res.status).toBe(429);
    expect(res.headers["content-type"]).toBe("application/json");
    expect(res.headers["retry-after"]).toBe("7");
    expect(res.headers["x-upstream-only"]).toBeUndefined();
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(JSON.parse(res.body)).toEqual({ echo: body.length });

    const got = seen.at(-1)!;
    expect(got.method).toBe("POST");
    expect(got.url).toBe("/api/gateway/v1/messages?beta=true");
    expect(got.body).toBe(body);
    expect(got.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(got.headers["content-type"]).toBe("application/json");
    expect(got.headers.host).toBe(`127.0.0.1:${upstreamPort}`);
    expect(JSON.stringify(got.headers)).not.toContain("agent-placeholder");
    for (const name of Object.keys(got.headers)) expect(["host", "authorization", "content-type", "content-length", "transfer-encoding", "connection"]).toContain(name);
  });

  test("streams the answer through as it arrives", async () => {
    let first = "";
    const pending = send(relayPort, {
      path: "/v1/messages?slow=1",
      headers: { "content-type": "application/json" },
      body: "{}",
      onFirstChunk: (chunk) => {
        first = chunk;
        // Upstream has not finished: it ends only once the first bytes reached the client.
        setTimeout(() => release(), 50);
      },
    });
    const res = await pending;
    expect(first).toBe("event: message_start\ndata: {}\n\n");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/event-stream");
    expect(res.body).toBe("event: message_start\ndata: {}\n\nevent: message_stop\ndata: {}\n\n");
  });

  test("refuses a body over the cap, declared or streamed", async () => {
    const before = seen.length;
    const declared = await send(relayPort, { headers: { "content-length": String(AGENT_RELAY_MAX_BODY + 1) }, body: "x" }).catch(() => ({ status: -1 }));
    expect(declared.status).toBe(413);
    expect(seen.length).toBe(before);

    const chunk = Buffer.alloc(1024 * 1024, 120);
    const streamed = await send(relayPort, { headers: { "content-type": "application/json" }, body: Array.from({ length: 9 }, () => chunk) });
    expect(streamed.status).toBe(413);
    // Exactly at the cap still goes through.
    const atCap = await send(relayPort, { headers: { "content-type": "application/json" }, body: Array.from({ length: 8 }, () => chunk) });
    expect(atCap.status).toBe(429);
    expect(seen.at(-1)!.body.length).toBe(AGENT_RELAY_MAX_BODY);
  });

  test("survives a client that disconnects mid-answer", async () => {
    await new Promise<void>((resolve) => {
      const req = request({ host: "127.0.0.1", port: relayPort, method: "POST", path: "/v1/messages?slow=1" }, (res) => {
        res.once("data", () => {
          req.destroy();
          resolve();
        });
      });
      req.on("error", () => {});
      req.end("{}");
    });
    await Bun.sleep(100);
    release();
    expect((await send(relayPort, { body: "{}" })).status).toBe(429);
    expect(relay.exitCode).toBeNull();
  });

  test("answers 502 when the target is down", async () => {
    const port = await freePort();
    const { child } = await startRelay(port, `http://127.0.0.1:${await freePort()}`);
    try {
      expect((await send(port, { body: "{}" })).status).toBe(502);
    } finally {
      child.kill();
    }
    expect(await new Response(child.stderr).text()).toMatch(/^relay: upstream \w+\n$/);
  });

  test("keeps the token out of its argv and its logs", async () => {
    const ps = Bun.spawnSync(["ps", "-ww", "-o", "args=", "-p", String(relay.pid)]);
    const args = ps.stdout.toString();
    expect(args).toContain("-e");
    expect(args).not.toContain(TOKEN);
    expect(relayLog).toBe(`relay: listening on 127.0.0.1:${relayPort}\n`);
  });
});

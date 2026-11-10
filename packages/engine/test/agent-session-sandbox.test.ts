/**
 * A verification session in a real Boat sandbox, which bills. No model provider: a scripted fake
 * messages endpoint runs inside the sandbox. Skipped unless a key is present:
 *
 *   bun run test:boat   # reads SANDCHEST_BOAT_API_KEY from the root .env.local
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { agentSandboxSetupScript, BoatWorkspace } from "@sandchest/workspace/boat";
import { AGENT_PLACEHOLDER_TOKEN, AGENT_USER, agentSessionStatus, collectAgentSession, prepareAgentSandbox, startAgentSession } from "../src/scan/slice";

const apiKey = process.env.SANDCHEST_BOAT_API_KEY ?? "";
const TIMEOUT = 300_000;
const RELAY_PORT = 4100;
const FAKE_PORT = 4200;
const TOKEN = `relay-test-${crypto.randomUUID()}`;
const FAKE_DIR = "/home/user/fake-endpoint";

/**
 * A messages endpoint with two scripted replies, streamed as server-sent events: first a call to the
 * shell tool (whichever tool takes a `command`) that writes the verdicts file, then a plain end of turn
 * once the tool result comes back. It logs each request's path and authorization.
 */
const FAKE_ENDPOINT = `"use strict";
const http = require("node:http");
const fs = require("node:fs");
const [port, verdictsPath, logPath] = process.argv.slice(2);
const verdicts = JSON.stringify([{ id: "F1", verdict: "false", attacker: "none", blocker: "src/app.ts:1", victim: "none", reason: "guarded" }]);
let n = 0;
http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let r = {};
    try { r = JSON.parse(body); } catch {}
    fs.appendFileSync(logPath, JSON.stringify({ url: req.url, authorization: req.headers.authorization || "", apiKey: req.headers["x-api-key"] || "" }) + "\\n");
    const shell = (r.tools || []).find((t) => t.input_schema && t.input_schema.properties && t.input_schema.properties.command);
    const answered = JSON.stringify(r.messages || []).includes('"tool_result"');
    const id = "msg_" + ++n;
    let block, delta, stop;
    if (shell && !answered) {
      block = { type: "tool_use", id: "toolu_" + n, name: shell.name, input: {} };
      delta = { type: "input_json_delta", partial_json: JSON.stringify({ command: "printf '%s\\\\n' '" + verdicts + "' > " + verdictsPath }) };
      stop = "tool_use";
    } else {
      block = { type: "text", text: "" };
      delta = { type: "text_delta", text: "Done." };
      stop = "end_turn";
    }
    const usage = { input_tokens: 10, output_tokens: 5 };
    const events = [
      { type: "message_start", message: { id, type: "message", role: "assistant", model: r.model, content: [], stop_reason: null, stop_sequence: null, usage } },
      { type: "content_block_start", index: 0, content_block: block },
      { type: "content_block_delta", index: 0, delta },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } },
      { type: "message_stop" },
    ];
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const e of events) res.write("event: " + e.type + "\\ndata: " + JSON.stringify(e) + "\\n\\n");
    res.end();
  });
}).listen(Number(port), "127.0.0.1", () => console.log("fake: listening"));
`;

/** Runs a probe as the agent user and returns its output once it ends. */
async function asAgent(workspace: BoatWorkspace, script: string): Promise<string> {
  const process = await workspace.spawn(["sh", "-c", script], { runAs: AGENT_USER });
  let status = await process.status();
  for (let i = 0; i < 60 && status.state === "running"; i++) {
    await Bun.sleep(1_000);
    status = await process.status();
  }
  return status.stdout;
}

describe.skipIf(!apiKey)("agent session on Boat", () => {
  let workspace: BoatWorkspace;

  beforeAll(async () => {
    const started = performance.now();
    const setupScript = agentSandboxSetupScript({ allowHosts: [], loopbackPorts: [RELAY_PORT], dns: false });
    workspace = await BoatWorkspace.create({ apiKey, type: "small", ttlSeconds: 15 * 60, labels: { purpose: "agent-session-test" }, setupScript });
    console.log(`create + ready: ${Math.round(performance.now() - started)}ms`);
  }, TIMEOUT);

  afterAll(() => workspace?.destroy(), TIMEOUT);

  test(
    "the agent CLI runs a session through the relay and writes verdicts that parse",
    async () => {
      await workspace.exec(["sh", "-c", "echo 'export const ok = 1;' > app.ts"]);
      // The fake endpoint and its log are the sandbox user's, out of the agent's reach.
      await workspace.exec(["mkdir", "-m", "700", "-p", FAKE_DIR]);
      await workspace.writeFiles([{ path: `${FAKE_DIR}/endpoint.cjs`, content: FAKE_ENDPOINT, mode: 0o600 }]);
      await workspace.spawn(["node", `${FAKE_DIR}/endpoint.cjs`, String(FAKE_PORT), `${workspace.agentDir}/verdicts.json`, `${FAKE_DIR}/seen.jsonl`]);

      let started = performance.now();
      await prepareAgentSandbox(workspace);
      console.log(`CLI install: ${Math.round(performance.now() - started)}ms`);
      started = performance.now();
      await prepareAgentSandbox(workspace);
      console.log(`CLI install again (no-op): ${Math.round(performance.now() - started)}ms`);

      started = performance.now();
      const ids = await startAgentSession(workspace, {
        kind: "refute",
        findings: [{ id: "F1", title: "missing check", entry: "app.ts:1", sink: "app.ts:1" }],
        relay: { port: RELAY_PORT, targetUrl: `http://127.0.0.1:${FAKE_PORT}`, token: TOKEN },
      });
      let state = await agentSessionStatus(workspace, ids);
      while (state === "running" && performance.now() - started < 180_000) {
        await Bun.sleep(2_000);
        state = await agentSessionStatus(workspace, ids);
      }
      console.log(`session: ${Math.round(performance.now() - started)}ms (${state})`);
      expect(state).toBe("finished");

      // The relay runs, visible to the agent, with the token in neither its arguments nor anything the agent can read.
      const ps = await asAgent(workspace, 'ps -u user -o args=; p="$(pgrep -u user -f SANDCHEST_RELAY_PORT | head -1)"; echo "relay-pid=$p"; cat "/proc/$p/environ" >/dev/null 2>&1 && echo environ=readable || echo environ=denied');
      expect(ps).toContain("SANDCHEST_RELAY_TOKEN");
      expect(ps).toMatch(/relay-pid=\d+/);
      expect(ps).toContain("environ=denied");
      expect(ps).not.toContain(TOKEN);

      const result = await collectAgentSession(workspace, ids);
      expect(result.error).toBeUndefined();
      expect(result).toMatchObject({ finished: true, turns: 2, exitCode: 0 });
      expect(result.verdicts.map((v) => [v.id, v.verdict, v.blocker])).toEqual([["F1", "false", "src/app.ts:1"]]);

      // Every call reached the endpoint with the relay's token, never the agent's placeholder.
      const seen = (await workspace.exec(["cat", `${FAKE_DIR}/seen.jsonl`])).stdout.trim().split("\n").map((line) => JSON.parse(line) as { url: string; authorization: string; apiKey: string });
      expect(seen.length).toBeGreaterThanOrEqual(2);
      for (const call of seen) {
        expect(call.url.split("?")[0]).toBe("/v1/messages");
        expect(call.authorization).toBe(`Bearer ${TOKEN}`);
        expect(call.apiKey).toBe("");
      }
      expect(JSON.stringify(seen)).not.toContain(AGENT_PLACEHOLDER_TOKEN);
      // The relay was stopped by collect.
      expect((await workspace.process(ids.relayProcessId).status()).state).not.toBe("running");
    },
    TIMEOUT,
  );

  test(
    "the agent user has no network but the relay port, no DNS, a read-only checkout and no sudo",
    async () => {
      // The relay is stopped after collect: start one again so port A has a listener to reach.
      const relay = await workspace.spawn(["node", "-e", "require('node:http').createServer((q, s) => { s.writeHead(404); s.end(); }).listen(" + RELAY_PORT + ", '127.0.0.1')"]);
      await Bun.sleep(1_500);
      try {
        const out = await asAgent(
          workspace,
          [
            `curl -s -o /dev/null -w "relay=%{http_code}\\n" --max-time 5 http://127.0.0.1:${RELAY_PORT}/ || echo relay=failed`,
            `curl -s -o /dev/null --max-time 5 http://127.0.0.1:${FAKE_PORT}/ && echo endpoint=reachable || echo endpoint=dropped`,
            "curl -s -o /dev/null --max-time 10 https://example.com && echo internet=reachable || echo internet=failed",
            "curl -sk -o /dev/null --max-time 5 https://1.1.1.1 && echo ip=reachable || echo ip=dropped",
            "getent hosts example.com >/dev/null && echo dns=resolved || echo dns=failed",
            // A raw query to a public resolver, past whatever /etc/resolv.conf names.
            `python3 -c "import socket; s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.settimeout(5); s.sendto(bytes.fromhex('abcd01000001000000000000076578616d706c6503636f6d0000010001'), ('1.1.1.1', 53)); s.recv(512)" 2>/dev/null && echo dns2=answered || echo dns2=failed`,
            `(echo x > ${workspace.root}/x) 2>/dev/null && echo checkout=writable || echo checkout=readonly`,
            "sudo -n true 2>/dev/null && echo sudo=yes || echo sudo=refused",
          ].join("; "),
        );
        console.log(out.trim().replaceAll("\n", " "));
        expect(out).toContain("relay=404");
        expect(out).toContain("endpoint=dropped");
        expect(out).toContain("internet=failed");
        expect(out).toContain("ip=dropped");
        expect(out).toContain("dns=failed");
        expect(out).toContain("dns2=failed");
        expect(out).toContain("checkout=readonly");
        expect(out).toContain("sudo=refused");
      } finally {
        await relay.stop();
      }
    },
    TIMEOUT,
  );

  test(
    "is gone after destroy",
    async () => {
      await workspace.destroy();
      const fresh = await BoatWorkspace.attach(workspace.id, { apiKey }).then(
        (attached) => attached.destroy(),
        () => undefined,
      );
      expect(fresh).toBeUndefined();
    },
    TIMEOUT,
  );
});

import { WorkspaceError } from "./index";

/** Environment variables the relay reads its settings from. */
export const AGENT_RELAY_ENV = {
  port: "SANDCHEST_RELAY_PORT",
  target: "SANDCHEST_RELAY_TARGET",
  token: "SANDCHEST_RELAY_TOKEN",
} as const;

/** Largest request body the relay forwards. */
export const AGENT_RELAY_MAX_BODY = 8 * 1024 * 1024;

export interface AgentRelaySettings {
  /** Loopback port it listens on. */
  port: number;
  /** Gateway base URL, `http://` or `https://`, with an optional base path and no query. */
  targetUrl: string;
  /** Sent upstream as `Authorization: Bearer <token>`. */
  token: string;
}

/**
 * Source of the relay: a plain CommonJS Node script, built-ins only. It
 * listens on 127.0.0.1, takes `POST /v1/messages` and nothing else, and
 * forwards it to the target with only the content type and its own
 * authorization, streaming the answer back as it arrives. Settings come from
 * `AGENT_RELAY_ENV`, so the token is never on a command line; it logs one
 * start line and error class names only.
 */
export function agentRelayScript(): string {
  return `"use strict";
const http = require("node:http");
const https = require("node:https");

const env = process.env;
const port = Number(env.${AGENT_RELAY_ENV.port});
const token = env.${AGENT_RELAY_ENV.token} || "";
delete env.${AGENT_RELAY_ENV.token};
let target;
try {
  target = new URL(env.${AGENT_RELAY_ENV.target} || "");
} catch {
  target = undefined;
}
if (!Number.isInteger(port) || port < 1 || port > 65535 || !target || !/^https?:$/.test(target.protocol) || !token || /[\\r\\n]/.test(token)) {
  console.error("relay: bad settings");
  process.exit(2);
}
const MAX_BODY = ${AGENT_RELAY_MAX_BODY};
const PATH = "/v1/messages";
const client = target.protocol === "https:" ? https : http;
const basePath = target.pathname.replace(/\\/+$/, "");

function answer(res, status) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { "content-type": "text/plain", connection: "close" });
  res.end();
}

function logError(where, error) {
  console.error("relay: " + where + " " + ((error && error.name) || "Error"));
}

const server = http.createServer((req, res) => {
  req.on("error", () => {});
  res.on("error", () => {});
  const url = req.url || "";
  const q = url.indexOf("?");
  const path = q < 0 ? url : url.slice(0, q);
  const query = q < 0 ? "" : url.slice(q);
  if (req.method !== "POST" || path !== PATH) {
    req.resume();
    answer(res, 404);
    return;
  }
  const declared = req.headers["content-length"];
  if (declared !== undefined && !(Number(declared) <= MAX_BODY)) {
    req.resume();
    answer(res, 413);
    return;
  }

  const headers = { host: target.host, authorization: "Bearer " + token };
  if (req.headers["content-type"]) headers["content-type"] = req.headers["content-type"];
  if (declared !== undefined) headers["content-length"] = declared;
  let upstream;
  try {
    upstream = client.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      method: "POST",
      path: basePath + PATH + query,
      headers,
    });
  } catch (error) {
    logError("request", error);
    req.resume();
    answer(res, 400);
    return;
  }

  let done = false;
  upstream.on("error", (error) => {
    if (done) return;
    done = true;
    logError("upstream", error);
    answer(res, 502);
  });
  upstream.on("response", (up) => {
    up.on("error", () => res.destroy());
    const out = {};
    for (const name of ["content-type", "retry-after"]) if (up.headers[name] !== undefined) out[name] = up.headers[name];
    res.writeHead(up.statusCode || 502, out);
    res.flushHeaders();
    up.on("end", () => {
      done = true;
    });
    up.pipe(res);
  });
  // A client that goes away takes its upstream call with it.
  res.on("close", () => {
    if (!res.writableFinished) {
      done = true;
      upstream.destroy();
    }
  });

  let size = 0;
  req.on("data", (chunk) => {
    if (done) return;
    size += chunk.length;
    if (size > MAX_BODY) {
      done = true;
      upstream.destroy();
      answer(res, 413);
      res.on("finish", () => setTimeout(() => req.destroy(), 1000).unref());
      return;
    }
    if (!upstream.write(chunk)) {
      req.pause();
      upstream.once("drain", () => req.resume());
    }
  });
  req.on("end", () => {
    if (!done) upstream.end();
  });
});
server.on("clientError", (_error, socket) => socket.destroy());
server.on("error", (error) => {
  logError("server", error);
  process.exit(1);
});
process.on("uncaughtException", (error) => logError("uncaught", error));
server.listen(port, "127.0.0.1", () => console.log("relay: listening on 127.0.0.1:" + port));
`;
}

/**
 * How to start the relay: run `cmd` with `env` (e.g. `BoatWorkspace.spawn(cmd, { env })`,
 * whose environment goes through a private file). The source is passed with
 * `node -e`, so there is no script file for anyone else to change.
 */
export function agentRelayCommand(settings: AgentRelaySettings): { cmd: string[]; env: Record<string, string> } {
  const { port, targetUrl, token } = settings;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new WorkspaceError(`Invalid relay port: ${port}`);
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    throw new WorkspaceError("Relay target is not a URL");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) {
    throw new WorkspaceError("Relay target must be an http(s) URL with no credentials, query or fragment");
  }
  if (!token || /[\r\n\0]/.test(token)) throw new WorkspaceError("Relay token is empty or has a line break");
  return {
    cmd: ["node", "-e", agentRelayScript()],
    env: { [AGENT_RELAY_ENV.port]: String(port), [AGENT_RELAY_ENV.target]: url.href.replace(/\/$/, ""), [AGENT_RELAY_ENV.token]: token },
  };
}

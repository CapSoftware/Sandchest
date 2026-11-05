/**
 * The self-hosted server's entry point (Node, no dependencies).
 *
 * Next.js listens on loopback only. In front of it, on the public port, a
 * small gateway forwards every request except the workflow routes: the
 * Postgres World delivers queued work to /.well-known/workflow/v1/flow over
 * loopback, and that route has no authentication of its own, so it must never
 * be reachable from outside the container. Blocking it here means it is
 * blocked however the server is exposed, with or without a reverse proxy.
 *
 * It also stands in for Vercel Cron, calling the stranded-scan sweep every
 * ten minutes and the advisory feeds every minute.
 */
import { randomBytes } from "node:crypto";
import http from "node:http";
import { pathToFileURL } from "node:url";

/** Every route under here belongs to the workflow runtime, and none of them is meant for the outside. */
const INTERNAL_PREFIX = "/.well-known/workflow";

/**
 * Routes where Next fetches a path it is given from inside the server, which
 * would carry a request past this gateway. The image optimiser is off (the
 * app has no next/image), and the route is refused here as well.
 */
const INTERNAL_FETCHERS = ["/_next/image"];

/** Headers that steer Next's routing internally. Never accepted from outside. */
const INTERNAL_HEADERS = /^(x-middleware-|x-invoke-|x-matched-path$|x-now-route-matches$|x-next-resume-state-length$)/i;

/** Hop-by-hop headers, which a proxy must not forward (RFC 9110 §7.6.1). */
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "te", "trailer", "upgrade", "proxy-authorization", "proxy-authenticate"]);

/** The largest request body forwarded. GitHub's webhook payloads are capped at 25 MB; nothing else here is larger. */
export const MAX_BODY_BYTES = 25 * 1024 * 1024;

/** Each layer of percent-decoding of `value`, starting with `value` itself; undefined if one is malformed. */
function decodings(value) {
  const forms = [value];
  for (let i = 0; i < 4; i++) {
    let decoded;
    try {
      decoded = decodeURIComponent(forms.at(-1));
    } catch {
      return undefined;
    }
    if (decoded === forms.at(-1)) break;
    forms.push(decoded);
  }
  return forms;
}

/**
 * Whether a request target reaches the workflow routes, however it is
 * spelled: percent-encoded (even twice), with dot segments, doubled or
 * backslashed slashes, or in any case. Also refused: targets naming them
 * anywhere, the query included, and routes that fetch a path they are given.
 * Absolute-form and other unusual targets are refused outright, since Next
 * would route them by their path.
 */
export function isBlocked(target) {
  if (typeof target !== "string" || !target.startsWith("/")) return true;
  const needle = INTERNAL_PREFIX.slice(1);
  const normalise = (form) => form.replace(/\\/g, "/").replace(/\/{2,}/g, "/");

  const whole = decodings(target);
  if (!whole || whole.some((form) => normalise(form).toLowerCase().includes(needle))) return true;

  // The path as sent, then each layer of percent-decoding: any of them might be what gets routed.
  const forms = decodings(target.split(/[?#]/, 1)[0]);
  if (!forms) return true;
  return forms.some((form) => {
    const slashed = normalise(form);
    // Resolves "." and ".." segments the way a URL parser would; a decoded "?" or "#" stays part of the path.
    const resolved = normalise(new URL(`/${slashed.replace(/^\/+/, "").replace(/[?#]/g, encodeURIComponent)}`, "http://gateway.invalid").pathname);
    return [slashed, resolved].some((path) => {
      const lower = path.toLowerCase();
      return lower.includes(needle) || INTERNAL_FETCHERS.some((prefix) => lower === prefix || lower.startsWith(`${prefix}/`));
    });
  });
}

/**
 * Forwards requests to Next on `upstreamPort`, refusing the workflow routes.
 *
 * Connections to Next are not capped, so slow clients cannot use up a pool
 * and stall everyone else; instead each request must arrive whole within
 * `requestTimeoutMs` (headers within `headersTimeoutMs`), and bodies over
 * MAX_BODY_BYTES are refused.
 */
export function createGateway({ upstreamHost = "127.0.0.1", upstreamPort, requestTimeoutMs = 60_000, headersTimeoutMs = 20_000, checkIntervalMs = 5_000 }) {
  const agent = new http.Agent({ keepAlive: true });
  const server = http.createServer(
    { requestTimeout: requestTimeoutMs, headersTimeout: Math.min(headersTimeoutMs, requestTimeoutMs), connectionsCheckingInterval: checkIntervalMs },
    (request, response) => {
      if (isBlocked(request.url)) return refuse(request, response, 404, "Not found\n");
      if (Number(request.headers["content-length"] ?? 0) > MAX_BODY_BYTES) return refuse(request, response, 413, "Request body too large\n");

      const headers = {};
      for (const [name, value] of Object.entries(request.headers)) {
        if (value === undefined || HOP_BY_HOP.has(name) || INTERNAL_HEADERS.test(name)) continue;
        headers[name] = value;
      }
      const peer = request.socket.remoteAddress ?? "";
      headers["x-forwarded-for"] = request.headers["x-forwarded-for"] ? `${request.headers["x-forwarded-for"]}, ${peer}` : peer;

      const upstream = http.request({ host: upstreamHost, port: upstreamPort, method: request.method, path: request.url, headers, agent }, (answer) => {
        const out = {};
        for (const [name, value] of Object.entries(answer.headers)) {
          if (value !== undefined && !HOP_BY_HOP.has(name)) out[name] = value;
        }
        response.writeHead(answer.statusCode ?? 502, answer.statusMessage, out);
        // Piped as it arrives, so the live feed's server-sent events stream through.
        answer.pipe(response);
        answer.on("error", () => response.destroy());
      });
      upstream.on("error", () => {
        if (!response.headersSent) {
          response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
          response.end("Sandchest is starting or unavailable. Try again in a moment.\n");
        } else {
          response.destroy();
        }
      });
      response.on("close", () => {
        if (!response.writableFinished) upstream.destroy();
      });
      // A chunked body has no length up front: count it as it streams.
      let received = 0;
      request.on("data", (chunk) => {
        received += chunk.length;
        if (received > MAX_BODY_BYTES) {
          upstream.destroy();
          refuse(request, response, 413, "Request body too large\n");
        }
      });
      request.pipe(upstream);
    },
  );
  // Nothing in the app upgrades connections; refuse rather than hang.
  server.on("upgrade", (_request, socket) => socket.destroy());
  server.on("clientError", (error, socket) => {
    const status = error.code === "ERR_HTTP_REQUEST_TIMEOUT" ? "408 Request Timeout" : "400 Bad Request";
    if (socket.writable) socket.end(`HTTP/1.1 ${status}\r\nconnection: close\r\n\r\n`);
    else socket.destroy();
  });
  server.on("close", () => agent.destroy());
  return server;
}

/** Answers without forwarding, and closes the connection so an unread body is not left on it. */
function refuse(request, response, status, message) {
  request.unpipe();
  if (!response.headersSent) {
    response.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", connection: "close" });
    response.end(message);
  }
  request.resume();
}

/**
 * Stops taking requests and ends the ones still open, such as a live feed's
 * stream: each one holds a connection to Next, which would otherwise keep
 * Next's own shutdown waiting until Docker kills the process.
 */
export function stopGateway(server) {
  server.close();
  server.closeAllConnections();
}

/** Calls the cron routes on loopback, as Vercel Cron does in the cloud (see vercel.json). Failures are logged and retried next time. */
function scheduleCrons(port, secret) {
  const every = (path, ms) => {
    const run = async () => {
      // Nothing to do until setup has given the server its GitHub App.
      if (!process.env.GITHUB_APP_ID?.trim()) return;
      try {
        const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(120_000) });
        if (!response.ok) console.error(`${path} failed: HTTP ${response.status}`);
      } catch (error) {
        console.error(`${path} failed: ${error instanceof Error ? error.message : "unknown error"}`);
      }
    };
    setTimeout(run, 60_000).unref();
    setInterval(run, ms).unref();
  };
  every("/api/cron/sweep", 10 * 60_000);
  every("/api/cron/advisories", 60_000);
}

async function main() {
  const publicPort = Number(process.env.PORT || 3000);
  const internalPort = Number(process.env.SANDCHEST_INTERNAL_PORT || 3001);
  if (!Number.isInteger(publicPort) || !Number.isInteger(internalPort) || publicPort === internalPort) {
    throw new Error("PORT and SANDCHEST_INTERNAL_PORT must be two different port numbers.");
  }
  // Next reads these when it starts: loopback only, on the internal port.
  process.env.PORT = String(internalPort);
  process.env.HOSTNAME = "127.0.0.1";
  // The World delivers work to Next directly, never through the gateway.
  process.env.WORKFLOW_LOCAL_BASE_URL = `http://127.0.0.1:${internalPort}`;
  // Only this process calls the crons, so a fresh secret per start is enough.
  process.env.CRON_SECRET ||= randomBytes(32).toString("hex");

  await import(pathToFileURL(process.env.SANDCHEST_NEXT_SERVER || "/app/apps/web/server.js").href);

  const gateway = createGateway({ upstreamPort: internalPort });
  gateway.listen(publicPort, "0.0.0.0", () => console.log(`Sandchest is listening on port ${publicPort}.`));
  scheduleCrons(internalPort, process.env.CRON_SECRET);

  // Next's own handler, registered as it started, closes Next and exits once its connections end.
  const stop = () => stopGateway(gateway);
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

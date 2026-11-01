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
 * ten minutes.
 */
import { randomBytes } from "node:crypto";
import http from "node:http";
import { pathToFileURL } from "node:url";

/** Every route under here belongs to the workflow runtime, and none of them is meant for the outside. */
const INTERNAL_PREFIX = "/.well-known/workflow";

/** Headers that steer Next's routing internally. Never accepted from outside. */
const INTERNAL_HEADERS = /^(x-middleware-|x-invoke-|x-matched-path$|x-now-route-matches$|x-next-resume-state-length$)/i;

/** Hop-by-hop headers, which a proxy must not forward (RFC 9110 §7.6.1). */
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "te", "trailer", "upgrade", "proxy-authorization", "proxy-authenticate"]);

/**
 * Whether a request target reaches the workflow routes, however it is
 * spelled: percent-encoded (even twice), with dot segments, doubled or
 * backslashed slashes, or in any case. Absolute-form and other unusual targets
 * are refused outright, since Next would route them by their path.
 */
export function isBlocked(target) {
  if (typeof target !== "string" || !target.startsWith("/")) return true;
  // The path as sent, then each layer of percent-decoding: any of them might be what gets routed.
  const forms = [target.split(/[?#]/, 1)[0]];
  for (let i = 0; i < 4; i++) {
    let decoded;
    try {
      decoded = decodeURIComponent(forms.at(-1));
    } catch {
      return true;
    }
    if (decoded === forms.at(-1)) break;
    forms.push(decoded);
  }
  const needle = INTERNAL_PREFIX.slice(1);
  return forms.some((form) => {
    const slashed = form.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
    // Resolves "." and ".." segments the way a URL parser would; a decoded "?" or "#" stays part of the path.
    const resolved = new URL(`/${slashed.replace(/^\/+/, "").replace(/[?#]/g, encodeURIComponent)}`, "http://gateway.invalid").pathname.replace(/\/{2,}/g, "/");
    return [slashed, resolved].some((path) => path.toLowerCase().includes(needle));
  });
}

/** Forwards requests to Next on `upstream`, refusing the workflow routes. */
export function createGateway({ upstreamHost = "127.0.0.1", upstreamPort }) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 256 });
  const server = http.createServer((request, response) => {
    if (isBlocked(request.url)) {
      request.resume();
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      response.end("Not found\n");
      return;
    }
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
    request.pipe(upstream);
  });
  // Nothing in the app upgrades connections; refuse rather than hang.
  server.on("upgrade", (_request, socket) => socket.destroy());
  server.on("clientError", (_error, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n");
    else socket.destroy();
  });
  server.on("close", () => agent.destroy());
  return server;
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

/** Calls the sweep on loopback, as Vercel Cron does in the cloud. Failures are logged and retried next time. */
function scheduleSweep(port, secret) {
  const sweep = async () => {
    // Nothing to sweep until setup has given the server its GitHub App.
    if (!process.env.GITHUB_APP_ID?.trim()) return;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/cron/sweep`, { headers: { authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(120_000) });
      if (!response.ok) console.error(`Sweep failed: HTTP ${response.status}`);
    } catch (error) {
      console.error(`Sweep failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  };
  setTimeout(sweep, 60_000).unref();
  setInterval(sweep, 10 * 60_000).unref();
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
  // Only this process calls the sweep, so a fresh secret per start is enough.
  process.env.CRON_SECRET ||= randomBytes(32).toString("hex");

  await import(pathToFileURL(process.env.SANDCHEST_NEXT_SERVER || "/app/apps/web/server.js").href);

  const gateway = createGateway({ upstreamPort: internalPort });
  gateway.listen(publicPort, "0.0.0.0", () => console.log(`Sandchest is listening on port ${publicPort}.`));
  scheduleSweep(internalPort, process.env.CRON_SECRET);

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

/**
 * The REST API at /api/v1: each operation's method and path, JSON in and
 * out, `Authorization: Bearer <key>`. Path parameters, the query string and
 * a JSON body are merged into the operation's input.
 */
import { ApiError } from "./errors";
import type { Operation } from "./operation";
import { OPERATIONS } from "./registry";
import { appUrl, authenticate, connectHelp, execute } from "./run";
import { isUuid } from "./resolve";

const HEADERS = {
  "cache-control": "no-store",
  // Bearer tokens, never cookies: any origin may call it, as with any API key.
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
};

/** Compact: agents pay for every byte, and `jq` or any client can indent it. */
export function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...HEADERS, ...extra } });
}

/** `resource`: the path of the resource that refused, for the 401's pointer to its OAuth metadata. */
export function errorResponse(error: ApiError, resource = ""): Response {
  const extra: Record<string, string> = {};
  if (error.status === 401) {
    const reason = error.code === "unauthorized" ? "" : `, error="invalid_token"`;
    extra["www-authenticate"] = `Bearer realm="sandchest", resource_metadata="${appUrl()}/.well-known/oauth-protected-resource${resource}"${reason}`;
  }
  return json(error.toJSON(), error.status, extra);
}

export function preflight(): Response {
  return new Response(null, { status: 204, headers: { ...HEADERS, "access-control-max-age": "86400" } });
}

/** Matches path segments to an operation's pattern. `{repo}` takes an id, or two segments as `owner/name`. */
export function matchPath(pattern: string, segments: string[]): Record<string, string> | undefined {
  const parts = pattern.split("/").filter(Boolean);
  const params: Record<string, string> = {};
  let i = 0;
  for (const part of parts) {
    const segment = segments[i];
    if (segment === undefined) return undefined;
    const param = /^\{(\w+)\}$/.exec(part)?.[1];
    if (!param) {
      if (segment !== part) return undefined;
      i++;
      continue;
    }
    if (param === "repo" && !isUuid(segment) && segments[i + 1] !== undefined) {
      params.repo = `${segment}/${segments[i + 1]}`;
      i += 2;
      continue;
    }
    params[param] = segment;
    i++;
  }
  return i === segments.length ? params : undefined;
}

/** The operation for a method and path, its path parameters, or what's allowed there. */
export function route(method: string, segments: string[]): { op: Operation; params: Record<string, string> } | { allowed: string[] } | undefined {
  const allowed: string[] = [];
  let best: { op: Operation; params: Record<string, string>; literals: number } | undefined;
  for (const op of OPERATIONS) {
    const params = matchPath(op.path, segments);
    if (!params) continue;
    if (op.method !== method) {
      allowed.push(op.method);
      continue;
    }
    // A literal segment beats a parameter: /findings/prompt is never a finding called "prompt".
    const literals = op.path.split("/").filter((part) => part && !part.startsWith("{")).length;
    if (!best || literals > best.literals) best = { op, params, literals };
  }
  if (best) return { op: best.op, params: best.params };
  return allowed.length > 0 ? { allowed: [...new Set(allowed)] } : undefined;
}

function queryInput(url: URL): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key);
    input[key] = values.length > 1 ? values : values[0];
  }
  return input;
}

export async function handleRest(request: Request, segments: string[]): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "OPTIONS") return preflight();
  const decoded = segments.map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  });
  // `owner%2Fname` arrives as one segment: split it like the two it stands for.
  const path = decoded.flatMap((segment) => segment.split("/")).filter(Boolean);
  if (path.length === 0 && method === "GET") return json(index());
  const found = route(method, path);
  if (!found) return errorResponse(new ApiError(404, "no_such_endpoint", `No endpoint ${method} /api/v1/${path.join("/")}. GET /api/v1 lists them.`));
  if ("allowed" in found) return errorResponse(new ApiError(405, "method_not_allowed", `Use ${found.allowed.join(" or ")} here.`));
  try {
    const principal = await authenticate(request);
    let body: Record<string, unknown> = {};
    if (method !== "GET" && method !== "DELETE") {
      const text = await request.text();
      if (text.trim()) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          throw new ApiError(400, "invalid_json", "The body must be JSON.");
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ApiError(400, "invalid_json", "The body must be a JSON object.");
        body = parsed as Record<string, unknown>;
      }
    }
    const input = { ...queryInput(new URL(request.url)), ...body, ...found.params };
    const result = await execute(found.op, input, { principal, surface: "api", appUrl: appUrl() });
    return json(result, found.op.status ?? 200);
  } catch (error) {
    if (error instanceof ApiError) return errorResponse(error);
    console.error("Agent API request failed");
    return errorResponse(new ApiError(500, "internal_error", "Something went wrong on Sandchest's side. Try again in a minute."));
  }
}

/** GET /api/v1: what this API is and how to use it, for an agent arriving cold. No key needed. */
export function index() {
  const base = appUrl();
  return {
    name: "Sandchest API",
    about: "Sandchest is a hacker for your team: it reviews pull requests and deep scans repositories for real, exploitable vulnerabilities. Everything in the dashboard can be done here.",
    docs: `${base}/docs/agents`,
    docs_markdown: `${base}/docs/agents.md`,
    openapi: `${base}/api/v1/openapi.json`,
    mcp_server: `${base}/api/mcp`,
    authentication: { header: "Authorization: Bearer <key>", ...connectHelp() },
    start_with: "GET /api/v1/me: who you act as, and next_steps.",
    endpoints: OPERATIONS.map((op) => ({ method: op.method, path: `/api/v1${op.path}`, tool: op.name, summary: op.title })),
  };
}

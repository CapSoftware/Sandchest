/**
 * The MCP server at /api/mcp: Streamable HTTP, stateless, JSON responses (no
 * SSE stream, no sessions). Every operation is a tool. MCP clients connect
 * with OAuth (they discover it from the 401's `resource_metadata`), or with
 * an API key in the Authorization header.
 */
import { ApiError } from "./errors";
import type { Principal } from "./operation";
import { OPERATIONS, operationByName } from "./registry";
import { errorResponse, json } from "./rest";
import { appUrl, authenticate, execute, freshAccess } from "./run";
import { inputSchema } from "./schema";

const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

type Message = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };

const result = (id: Message["id"], value: unknown) => ({ jsonrpc: "2.0", id, result: value });
const failure = (id: Message["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

export const INSTRUCTIONS = `Sandchest is a hacker for the person's team: it reviews their pull requests and deep scans their GitHub repositories for real, exploitable vulnerabilities, with evidence and a fix prompt for each.
Start with get_me: it says who you act as and lists next_steps in order. Steps only a person can take come with a URL to hand them: installing the GitHub App, and the first card payment on Stripe Checkout. Calls that wait on the person (list_accounts, get_billing, and the device token) take wait=50 and return as soon as they're done. Everything else you can do: claim free credits, buy credits on the saved card, start deep scans, follow them (get_scan with wait), read findings and fix them with get_fix_prompt, dismiss or reopen findings, and change settings.
Accounts are GitHub accounts (a person or an organization) and can be named by login; repositories by owner/name. Billing and settings changes need the person to be an admin of the account.`;

function tools() {
  return OPERATIONS.map((op) => ({
    name: op.name,
    title: op.title,
    description: op.description,
    inputSchema: inputSchema(op),
    annotations: { readOnlyHint: !!op.readOnly, destructiveHint: !!op.destructive, idempotentHint: !!op.idempotent || !!op.readOnly, openWorldHint: !!op.openWorld },
  }));
}

async function answer(message: Message, principal: Principal): Promise<unknown> {
  const { id, method, params = {} } = message;
  switch (method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : VERSIONS[0]!;
      return result(id, {
        protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "sandchest", title: "Sandchest", version: "1.0.0", websiteUrl: appUrl() },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return result(id, {});
    case "tools/list":
      return result(id, { tools: tools() });
    case "tools/call": {
      const op = typeof params.name === "string" ? operationByName(params.name) : undefined;
      if (!op) return failure(id, -32602, `Unknown tool: ${String(params.name)}`);
      const args = params.arguments && typeof params.arguments === "object" ? (params.arguments as Record<string, unknown>) : {};
      try {
        await freshAccess(principal);
        const value = await execute(op, args, { principal, surface: "mcp", appUrl: appUrl() });
        const structured = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : { result: value };
        return result(id, { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: structured });
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        // Tool errors go back to the model, which can act on them; only auth failures stop the connection.
        if (error.status === 401) throw error;
        return result(id, { content: [{ type: "text", text: JSON.stringify(error.toJSON()) }], structuredContent: error.toJSON(), isError: true });
      }
    }
    case "resources/list":
      return result(id, { resources: [] });
    case "prompts/list":
      return result(id, { prompts: [] });
    default:
      return failure(id, -32601, `Method not found: ${String(method)}`);
  }
}

export async function handleMcp(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  // No server-to-client stream: clients fall back to plain request/response.
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST", ...corsHeaders() } });
  let message: Message;
  try {
    message = (await request.json()) as Message;
  } catch {
    return json(failure(null, -32700, "Parse error"), 400, corsHeaders());
  }
  if (!message || typeof message !== "object" || Array.isArray(message) || typeof message.method !== "string") {
    return json(failure(null, -32600, "Invalid request: send one JSON-RPC message per POST"), 400, corsHeaders());
  }
  try {
    // Every request needs a token, so a client without one is sent to OAuth at once (the 401 names the metadata).
    const principal = await authenticate(request, { freshAccess: false });
    // Notifications and responses get no answer.
    if (message.id === undefined || message.id === null) return new Response(null, { status: 202, headers: corsHeaders() });
    return json(await answer(message, principal), 200, corsHeaders());
  } catch (error) {
    if (error instanceof ApiError) {
      const response = errorResponse(error, "/api/mcp");
      for (const [key, value] of Object.entries(corsHeaders())) response.headers.set(key, value);
      return response;
    }
    console.error("MCP request failed");
    return json(failure(message.id, -32603, "Internal error"), 500, corsHeaders());
  }
}

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, content-type, mcp-protocol-version, mcp-session-id",
    "access-control-allow-methods": "POST, GET, OPTIONS",
    "access-control-expose-headers": "www-authenticate, mcp-session-id",
    "cache-control": "no-store",
  };
}

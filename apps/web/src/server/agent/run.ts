/**
 * Running an operation for a request: the bearer token is checked (one
 * query), the person's GitHub access is kept fresh as the dashboard keeps
 * it, the input is validated, and every failure becomes an ApiError an agent
 * can act on. Shared by the REST API and the MCP server.
 */
import { tokenPrincipal, touchToken } from "@sandchest/db";
import { GitHubError } from "@sandchest/github";
import { z } from "zod";
import { ensureAccess } from "../access";
import { later, track } from "../analytics";
import { config } from "../config";
import { db } from "../db";
import { describeError } from "../log";
import { captureException } from "../sentry";
import { ApiError } from "./errors";
import type { Context, Operation, Principal } from "./operation";
import { PREFIX, sha256 } from "./tokens";

export function appUrl(): string {
  return config().SANDCHEST_APP_URL.replace(/\/$/, "");
}

/** How to connect, said in every 401 so an agent that hits the API cold knows what to do. */
export function connectHelp() {
  const base = appUrl();
  return {
    docs: `${base}/docs/agents`,
    mcp_server: `${base}/api/mcp`,
    device_flow: `POST ${base}/api/v1/auth/device, show the person verification_uri_complete, then call POST ${base}/api/oauth/token with the device_code and wait=50 (repeat while it answers authorization_pending) until it returns access_token.`,
  };
}

const unauthorized = (code: string, message: string) => new ApiError(401, code, message, { how_to_connect: connectHelp() });

/**
 * Not a 401: the key is fine, and a 401 would only make an MCP client sign in
 * again, which can't fix GitHub. The person must sign in on the site.
 */
const reauth = () =>
  new ApiError(403, "github_reauth_required", `The person's GitHub sign-in has expired or was revoked. Ask them to sign in once at ${appUrl()}/sign-in; this key keeps working after that.`, {
    sign_in_url: `${appUrl()}/sign-in`,
  });

const FIVE_MINUTES = 5 * 60_000;

/**
 * The person a request's `Authorization: Bearer` token acts as. Their GitHub
 * access is made fresh too, unless `freshAccess` is false: the MCP server
 * checks it per tool call instead, so a lapsed GitHub sign-in reaches the
 * model as a tool error it can relay.
 */
export async function authenticate(request: Request, options: { freshAccess?: boolean } = {}): Promise<Principal> {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get("authorization") ?? "");
  if (!match) throw unauthorized("unauthorized", "Send an API key as `Authorization: Bearer <key>`.");
  const token = match[1]!;
  if (!token.startsWith(PREFIX.key) && !token.startsWith(PREFIX.access)) throw unauthorized("invalid_token", "That isn't a Sandchest API key or access token.");
  const found = await tokenPrincipal(db(), sha256(token));
  if (!found) throw unauthorized("invalid_token", "That key or token is unknown, revoked or expired. Connect again to get a new one.");
  if (!found.lastUsedAt || Date.now() - found.lastUsedAt.getTime() > FIVE_MINUTES) later(() => touchToken(db(), found.tokenId));
  const principal: Principal = {
    userId: found.user.id,
    login: found.user.login,
    name: found.user.name,
    githubUserId: found.user.githubUserId,
    tokenId: found.tokenId,
    tokenKind: found.kind === "access" ? "access" : "key",
    accessCheckedAt: found.user.accessCheckedAt,
  };
  if (options.freshAccess !== false) await freshAccess(principal);
  return principal;
}

/** Keeps the person's GitHub access fresh, as every dashboard page does. */
export async function freshAccess(principal: Principal): Promise<void> {
  try {
    await ensureAccess(principal.userId, { checkedAt: principal.accessCheckedAt });
  } catch (error) {
    if (error instanceof GitHubError && error.status === 401) throw reauth();
    throw error;
  }
}

function issuesOf(error: z.ZodError) {
  return error.issues.map((issue) => ({ field: issue.path.join(".") || null, message: issue.message }));
}

/** Validates the input and runs the operation as the principal. Throws ApiError for anything that goes wrong. */
export async function execute(op: Operation, raw: Record<string, unknown>, context: Context): Promise<unknown> {
  const parsed = op.input.safeParse(raw);
  if (!parsed.success) {
    const issues = issuesOf(parsed.error);
    const first = issues[0];
    throw new ApiError(422, "invalid_input", `Invalid input${first?.field ? ` for ${first.field}` : ""}: ${first?.message ?? "check the parameters"}.`, { issues });
  }
  let status = op.status ?? 200;
  try {
    return await op.run(context, parsed.data);
  } catch (error) {
    status = error instanceof ApiError ? error.status : 500;
    if (error instanceof ApiError) throw error;
    if (error instanceof GitHubError && error.status === 401) throw reauth();
    console.error(`Agent operation ${op.name} failed: ${describeError(error)}`);
    await captureException(error, { source: "agent", tags: { operation: op.name, surface: context.surface } });
    throw new ApiError(500, "internal_error", "Something went wrong on Sandchest's side. Nothing was changed that you weren't told about; try again in a minute.");
  } finally {
    // Changes are recorded (reads would drown them out): which tool, from where, and whether it went through.
    if (!op.readOnly) await track("agent_call", { userId: context.principal.userId, props: { operation: op.name, surface: context.surface, status: status } });
  }
}

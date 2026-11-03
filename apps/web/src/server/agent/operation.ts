/**
 * One operation, served three ways: a REST endpoint (/api/v1), an MCP tool
 * (/api/mcp) and an OpenAPI entry. Each is defined once, with a zod schema
 * for its input (path, query and body merged) and a handler that acts as the
 * person the agent's token belongs to.
 */
import { z } from "zod";

export interface Principal {
  userId: string;
  login: string | null;
  name: string;
  githubUserId: number | null;
  /** The token the request came with: `revoke_api_key` with id "current" revokes it. */
  tokenId: string;
  /** An API key, or an MCP client's short-lived OAuth access token. */
  tokenKind: "key" | "access";
  /** When the person's access was last read from GitHub. */
  accessCheckedAt: Date | null;
}

export interface Context {
  principal: Principal;
  surface: "api" | "mcp";
  /** This deployment's public address, without a trailing slash. */
  appUrl: string;
}

export interface Operation<S extends z.ZodObject = z.ZodObject> {
  /** The MCP tool's name. */
  name: string;
  /** A short human title. */
  title: string;
  /** What it does and when to use it, for the agent choosing it. */
  description: string;
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** The REST path under /api/v1, with `{param}` segments. `{repo}` also matches `owner/name`. */
  path: string;
  input: S;
  /** The HTTP status on success. Default 200. */
  status?: number;
  /** MCP hints. A read-only operation changes nothing. */
  readOnly?: boolean;
  destructive?: boolean;
  idempotent?: boolean;
  /** Reaches outside Sandchest (Stripe, GitHub). */
  openWorld?: boolean;
  run(context: Context, input: z.output<S>): Promise<unknown>;
}

export function operation<S extends z.ZodObject>(definition: Operation<S>): Operation {
  return definition as unknown as Operation;
}

// ---- Input helpers -----------------------------------------------------------

/** A boolean that also accepts "true"/"false"/"1"/"0", as query strings send them. */
export const flag = () =>
  z.preprocess((value) => {
    if (value === "true" || value === "1") return true;
    if (value === "false" || value === "0") return false;
    return value;
  }, z.boolean());

/** An integer that also accepts its digits as a string (query strings). */
export const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

/** A repository: its id, or `owner/name`. */
export const RepoRef = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .describe("The repository: its id, or its full name as `owner/name`.");

/** A GitHub account Sandchest is installed on: its id, or its GitHub login. */
export const AccountRef = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .describe("The GitHub account (user or organization) Sandchest is installed on: its id, or its GitHub login.");

export const Uuid = (what: string) => z.uuid().describe(`The ${what}'s id.`);

export const SEVERITY = z.enum(["critical", "high", "medium", "low"]);

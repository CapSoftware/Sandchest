/**
 * Agents' secrets: API keys, OAuth tokens and codes, device codes. Each is 32
 * random bytes behind a prefix that says what it is (so secret scanners and
 * people can tell them apart), and only its SHA-256 is stored.
 */
import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import { createApiToken } from "@sandchest/db";
import { db } from "../db";

export const PREFIX = { key: "sck_", access: "sca_", refresh: "scr_", device: "scd_", client: "scc_" } as const;

/** How long OAuth tokens last. Refresh tokens rotate on every use. */
export const ACCESS_TTL_S = 24 * 3_600;
export const REFRESH_TTL_S = 90 * 24 * 3_600;
/** How long a device code and an authorization code may wait. */
export const DEVICE_TTL_S = 15 * 60;
export const CODE_TTL_S = 5 * 60;
/** Seconds between device-flow polls. */
export const DEVICE_INTERVAL_S = 5;

export function secret(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** What Settings shows of a key: its kind and first characters. */
export function displayPrefix(token: string): string {
  return token.slice(0, 10);
}

// ---- Device codes ----------------------------------------------------------

/** No vowels (no words), no lookalikes: RFC 8628 §6.1's advice. */
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";

export function userCode(): string {
  let code = "";
  for (let i = 0; i < 8; i++) code += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  return code;
}

/** A code as typed: any case, with or without the dash or spaces. Undefined if it can't be one. */
export function normaliseUserCode(typed: string | null | undefined): string | undefined {
  const code = (typed ?? "").toUpperCase().replace(/[\s-]/g, "");
  return code.length === 8 && [...code].every((c) => USER_CODE_ALPHABET.includes(c)) ? code : undefined;
}

export function formatUserCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

// ---- Issuing ---------------------------------------------------------------

/** A short name an agent or person gave a key: printable, one line, at most 80 characters. */
export function cleanName(name: string | null | undefined, fallback: string): string {
  const clean = (name ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return clean || fallback;
}

/** A new API key for a person. The secret is returned once and never stored. */
export async function issueKey(userId: string, name: string): Promise<{ id: string; key: string; createdAt: Date }> {
  const key = secret(PREFIX.key);
  const row = await createApiToken(db(), { userId, kind: "key", name, tokenHash: sha256(key), prefix: displayPrefix(key) });
  return { id: row.id, key, createdAt: row.createdAt };
}

/** A new access and refresh token for an MCP client's sign-in. A new sign-in starts a new family. */
export async function issueOAuthPair(input: { userId: string; clientId: string; name: string; family?: string }): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const family = input.family ?? randomUUID();
  const accessToken = secret(PREFIX.access);
  const refreshToken = secret(PREFIX.refresh);
  const now = Date.now();
  const common = { userId: input.userId, clientId: input.clientId, name: input.name, family };
  await Promise.all([
    createApiToken(db(), { ...common, kind: "access", tokenHash: sha256(accessToken), prefix: displayPrefix(accessToken), expiresAt: new Date(now + ACCESS_TTL_S * 1_000) }),
    createApiToken(db(), { ...common, kind: "refresh", tokenHash: sha256(refreshToken), prefix: displayPrefix(refreshToken), expiresAt: new Date(now + REFRESH_TTL_S * 1_000) }),
  ]);
  return { accessToken, refreshToken, expiresIn: ACCESS_TTL_S };
}

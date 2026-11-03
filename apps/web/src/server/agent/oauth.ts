/**
 * OAuth 2.1 for agents: MCP clients register themselves (RFC 7591), send the
 * person to /oauth/authorize, and swap the code for tokens with PKCE. Agents
 * without a browser use the device flow (RFC 8628) and get an API key. Both
 * end at the token endpoint here.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { createDeviceGrant, deviceGrantStatus, type DevicePoll, oauthClient, pollDeviceGrant, recentlyAdded, registerOAuthClient, revokeTokenByHash, saveOAuthCode, spendRefreshToken, takeOAuthCode } from "@sandchest/db";
import { track } from "../analytics";
import { db } from "../db";
import { admit, clientAddress, hold } from "../rate-limit";
import { appUrl } from "./run";
import { cleanName, CODE_TTL_S, DEVICE_INTERVAL_S, DEVICE_TTL_S, displayPrefix, formatUserCode, issueOAuthPair, PREFIX, secret, sha256, userCode } from "./tokens";

export const SCOPE = "sandchest";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
/** The longest the token endpoint holds a device poll open. */
const MAX_WAIT_S = 50;

/**
 * Registration and the device flow need no account, so one address gets 20
 * clients and 20 device codes per 10 minutes, 60 device polls a minute and 5
 * polls held open at once (per server instance: see rate-limit.ts). Across
 * everyone, at most PER_HOUR new clients and device codes an hour: far above
 * real use, it bounds what scripts spread over many addresses can add.
 */
const PER_ADDRESS = { clients: 20, deviceCodes: 20, polls: 60, waits: 5 };
const WINDOW_MS = 10 * 60_000;
const PER_HOUR = 1_000;

const HEADERS = { "cache-control": "no-store", pragma: "no-cache", "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type" };

export function oauthJson(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...HEADERS, ...headers } });
}

export const oauthError = (error: string, description: string, status = 400) => oauthJson({ error, error_description: description }, status);

const tooMany = (error: string, description: string, retryS: number) => oauthJson({ error, error_description: description }, 429, { "retry-after": String(retryS) });

/** Whether the last hour's new rows, across every instance, are at the ceiling. */
const atCeiling = async (table: "oauth_clients" | "device_grants") => (await recentlyAdded(db(), table, 3_600, PER_HOUR)) >= PER_HOUR;

export function corsPreflight(): Response {
  return new Response(null, { status: 204, headers: { ...HEADERS, "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-max-age": "86400" } });
}

/** A form-encoded or JSON body as plain strings. */
export async function readParams(request: Request): Promise<Record<string, unknown>> {
  const type = request.headers.get("content-type") ?? "";
  const text = await request.text();
  if (!text.trim()) return {};
  if (type.includes("application/json") || /^\s*\{/.test(text)) {
    try {
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(text));
}

const str = (value: unknown) => (typeof value === "string" ? value : undefined);

// ---- Metadata ----------------------------------------------------------------

export function authorizationServerMetadata() {
  const base = appUrl();
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/api/oauth/token`,
    registration_endpoint: `${base}/api/oauth/register`,
    revocation_endpoint: `${base}/api/oauth/revoke`,
    device_authorization_endpoint: `${base}/api/v1/auth/device`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token", DEVICE_GRANT],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [SCOPE],
    service_documentation: `${base}/docs/agents`,
  };
}

/** RFC 9728. `resource` is the MCP server for its path-specific copy, and the whole site otherwise. */
export function protectedResourceMetadata(resource: string) {
  return {
    resource,
    authorization_servers: [appUrl()],
    bearer_methods_supported: ["header"],
    scopes_supported: [SCOPE],
    resource_name: "Sandchest",
    resource_documentation: `${appUrl()}/docs/agents`,
  };
}

// ---- Client registration -----------------------------------------------------

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const FORBIDDEN_SCHEMES = new Set(["javascript:", "data:", "file:", "vbscript:", "about:", "blob:", "ftp:", "ws:", "wss:"]);

/** Where a client may send people back: https, loopback http (any port), or an app's own scheme. Never a fragment. */
export function allowedRedirect(uri: string): boolean {
  if (uri.length > 2_000) return false;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.hash || FORBIDDEN_SCHEMES.has(url.protocol)) return false;
  if (url.protocol === "https:") return !!url.hostname;
  if (url.protocol === "http:") return LOOPBACK.has(url.hostname);
  // An app's own scheme (cursor://, vscode://): RFC 8252 §7.1.
  return /^[a-z][a-z0-9+.-]*:$/.test(url.protocol);
}

export async function register(request: Request): Promise<Response> {
  if (!admit(`register ${clientAddress(request)}`, PER_ADDRESS.clients, WINDOW_MS)) return tooMany("too_many_requests", "Too many registrations from this address. Register once and reuse the client_id.", 600);
  const params = await readParams(request);
  const uris = params.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10 || !uris.every((uri) => typeof uri === "string" && allowedRedirect(uri))) {
    return oauthError("invalid_redirect_uri", "redirect_uris must list 1-10 https URLs, loopback http URLs or app-scheme URLs, without fragments.");
  }
  const method = str(params.token_endpoint_auth_method);
  if (method && method !== "none") return oauthError("invalid_client_metadata", "Only public clients are supported: token_endpoint_auth_method must be \"none\" (PKCE is required).");
  const id = secret(PREFIX.client).slice(0, 4 + 22);
  const name = cleanName(str(params.client_name), "MCP client");
  if (await atCeiling("oauth_clients")) return tooMany("too_many_requests", "Too many registrations right now. Try again later.", 600);
  const row = await registerOAuthClient(db(), { id, name, redirectUris: uris as string[] });
  return oauthJson(
    {
      client_id: id,
      client_id_issued_at: Math.floor(row.createdAt.getTime() / 1_000),
      client_name: name,
      redirect_uris: uris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: SCOPE,
    },
    201,
  );
}

// ---- Authorization -----------------------------------------------------------

export type AuthorizeRequest = { clientId: string; clientName: string; redirectUri: string; codeChallenge: string; state: string | null };

/**
 * Checks an authorization request. Without a known client and one of its
 * redirect URIs nothing can be sent back, so the page shows the problem;
 * other problems go back to the client as OAuth errors.
 */
export async function checkAuthorize(params: Record<string, string | undefined>): Promise<{ ok: true; request: AuthorizeRequest } | { ok: false; show: string } | { ok: false; redirect: string }> {
  const client = params.client_id ? await oauthClient(db(), params.client_id) : undefined;
  if (!client) return { ok: false, show: "This app isn't registered with Sandchest. Ask it to connect again." };
  const redirectUri = params.redirect_uri ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : undefined);
  if (!redirectUri || !client.redirectUris.includes(redirectUri)) return { ok: false, show: "This app asked to send you somewhere it didn't register. Nothing was shared." };
  const back = (error: string, description: string) => ({ ok: false as const, redirect: withParams(redirectUri, { error, error_description: description, state: params.state, iss: appUrl() }) });
  if (params.response_type !== "code") return back("unsupported_response_type", "Only response_type=code is supported.");
  if (!params.code_challenge || params.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(params.code_challenge)) {
    return back("invalid_request", "PKCE is required: send code_challenge with code_challenge_method=S256.");
  }
  if (params.scope && !params.scope.split(" ").every((scope) => scope === SCOPE || scope === "")) return back("invalid_scope", `The only scope is "${SCOPE}".`);
  return { ok: true, request: { clientId: client.id, clientName: client.name, redirectUri, codeChallenge: params.code_challenge, state: params.state ?? null } };
}

export function withParams(uri: string, params: Record<string, string | null | undefined>): string {
  const url = new URL(uri);
  for (const [key, value] of Object.entries(params)) if (value) url.searchParams.set(key, value);
  return url.toString();
}

/** A code for the client, after the person approved. */
export async function issueCode(request: AuthorizeRequest, userId: string): Promise<string> {
  const code = secret("");
  await saveOAuthCode(db(), { codeHash: sha256(code), clientId: request.clientId, userId, redirectUri: request.redirectUri, codeChallenge: request.codeChallenge, expiresAt: new Date(Date.now() + CODE_TTL_S * 1_000) });
  return withParams(request.redirectUri, { code, state: request.state, iss: appUrl() });
}

// ---- Token endpoint ----------------------------------------------------------

function pkceMatches(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const given = Buffer.from(createHash("sha256").update(verifier).digest("base64url"));
  const wanted = Buffer.from(challenge);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

export async function token(request: Request): Promise<Response> {
  const params = await readParams(request);
  const grant = str(params.grant_type);
  if (grant === "authorization_code") {
    const code = str(params.code);
    const clientId = str(params.client_id);
    const verifier = str(params.code_verifier);
    if (!code || !clientId || !verifier) return oauthError("invalid_request", "code, client_id and code_verifier are required.");
    const stored = await takeOAuthCode(db(), sha256(code));
    if (!stored || stored.clientId !== clientId || (str(params.redirect_uri) ?? stored.redirectUri) !== stored.redirectUri || !pkceMatches(verifier, stored.codeChallenge)) {
      return oauthError("invalid_grant", "The code is invalid, expired, already used, or doesn't match this client, redirect_uri or code_verifier.");
    }
    const client = await oauthClient(db(), clientId);
    const pair = await issueOAuthPair({ userId: stored.userId, clientId, name: client?.name ?? "MCP client" });
    return oauthJson({ access_token: pair.accessToken, token_type: "Bearer", expires_in: pair.expiresIn, refresh_token: pair.refreshToken, scope: SCOPE });
  }
  if (grant === "refresh_token") {
    const refresh = str(params.refresh_token);
    const clientId = str(params.client_id);
    if (!refresh || !clientId) return oauthError("invalid_request", "refresh_token and client_id are required.");
    const spent = await spendRefreshToken(db(), sha256(refresh), clientId);
    if (!spent.ok) return oauthError("invalid_grant", "The refresh token is invalid, expired or already used. Connect again.");
    const pair = await issueOAuthPair({ userId: spent.userId, clientId, name: spent.name, family: spent.family });
    return oauthJson({ access_token: pair.accessToken, token_type: "Bearer", expires_in: pair.expiresIn, refresh_token: pair.refreshToken, scope: SCOPE });
  }
  if (grant === DEVICE_GRANT) {
    const deviceCode = str(params.device_code);
    if (!deviceCode || !deviceCode.startsWith(PREFIX.device)) return oauthError("invalid_request", "device_code is required.");
    const address = clientAddress(request);
    if (!admit(`poll ${address}`, PER_ADDRESS.polls, 60_000)) return tooMany("slow_down", `Too many polls from this address: wait at least ${DEVICE_INTERVAL_S} seconds between polls.`, DEVICE_INTERVAL_S);
    // `wait`: hold the request until the person decides (up to 50 s), so an agent that can't loop needs one call.
    // Only a poll that wasn't too soon may wait (so waits can't be stacked on one code), and waiting only reads.
    // One address holds only a few open at once, so many device codes can't each pin a worker.
    const wait = Math.min(Math.max(Number(params.wait) || 0, 0), MAX_WAIT_S);
    const release = wait > 0 ? hold(`wait ${address}`, PER_ADDRESS.waits) : undefined;
    if (wait > 0 && !release) return tooMany("slow_down", `Too many polls waiting from this address: poll without wait, every ${DEVICE_INTERVAL_S} seconds.`, DEVICE_INTERVAL_S);
    const key = secret(PREFIX.key);
    const issue = { tokenHash: sha256(key), prefix: displayPrefix(key) };
    const hash = sha256(deviceCode);
    let poll: DevicePoll;
    try {
      poll = await pollDeviceGrant(db(), hash, DEVICE_INTERVAL_S, issue);
      const until = Date.now() + wait * 1_000;
      while (wait > 0 && poll.state === "pending" && Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(2_000, until - Date.now())));
        const now = await deviceGrantStatus(db(), hash);
        if (!now || now.expired || now.status !== "pending") {
          poll = await pollDeviceGrant(db(), hash, 0, issue);
          break;
        }
      }
    } finally {
      release?.();
    }
    switch (poll.state) {
      case "pending":
        return oauthError("authorization_pending", "The person hasn't approved yet. Poll again after `interval` seconds, or pass wait=50 to hold the request until they do.");
      case "slow_down":
        return oauthError("slow_down", `Polling too fast: wait at least ${DEVICE_INTERVAL_S} seconds between polls.`);
      case "denied":
        return oauthError("access_denied", "The person denied the request.");
      case "expired":
        return oauthError("expired_token", "The code expired. Start again with a new device code.");
      case "invalid":
        return oauthError("invalid_grant", "Unknown device code, or its key was already issued.");
      case "issued":
        await track("api_key_created", { userId: poll.userId, props: { via: "device", kind: "key", outcome: "ok" } });
        return oauthJson({
          access_token: key,
          token_type: "Bearer",
          scope: SCOPE,
          note: `An API key: it doesn't expire, so store it (e.g. as SANDCHEST_API_KEY) and send it as Authorization: Bearer <key>. Start with GET ${appUrl()}/api/v1/me.`,
        });
    }
  }
  return oauthError("unsupported_grant_type", "Use authorization_code, refresh_token or urn:ietf:params:oauth:grant-type:device_code.");
}

export async function revoke(request: Request): Promise<Response> {
  const value = str((await readParams(request)).token);
  if (value) await revokeTokenByHash(db(), sha256(value));
  return new Response(null, { status: 200, headers: HEADERS });
}

// ---- Device authorization ----------------------------------------------------

export async function startDevice(request: Request): Promise<Response> {
  if (!admit(`device ${clientAddress(request)}`, PER_ADDRESS.deviceCodes, WINDOW_MS)) return tooMany("too_many_requests", "Too many device codes from this address. Finish connecting with the last one, or try again in a few minutes.", 600);
  if (await atCeiling("device_grants")) return tooMany("too_many_requests", "Too many device codes right now. Try again in a few minutes.", 600);
  const params = await readParams(request);
  const name = cleanName(str(params.client_name) ?? str(params.name) ?? request.headers.get("user-agent")?.split(/[\s/]/)[0], "Agent");
  const deviceCode = secret(PREFIX.device);
  const base = appUrl();
  for (let attempt = 0; ; attempt++) {
    const code = userCode();
    try {
      await createDeviceGrant(db(), { deviceCodeHash: sha256(deviceCode), userCode: code, clientName: name, expiresAt: new Date(Date.now() + DEVICE_TTL_S * 1_000) });
      return oauthJson({
        device_code: deviceCode,
        user_code: formatUserCode(code),
        verification_uri: `${base}/device`,
        verification_uri_complete: `${base}/device?code=${code}`,
        expires_in: DEVICE_TTL_S,
        interval: DEVICE_INTERVAL_S,
        next: `Ask the person to open verification_uri_complete and approve (they sign in with GitHub if needed; the page shows code ${formatUserCode(code)}). Meanwhile call POST ${base}/api/oauth/token with grant_type=${DEVICE_GRANT}&device_code=<device_code>&wait=50: it holds up to 50 seconds for them to approve. Repeat while it answers authorization_pending; it returns access_token once they do.`,
      });
    } catch (error) {
      // A user code collision (one in billions): roll another.
      if (attempt >= 2) throw error;
    }
  }
}

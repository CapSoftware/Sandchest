/**
 * Granular API key scopes following `resource:action` pattern.
 * A key with no scopes (or `undefined`) is treated as full-access for backward compatibility.
 */

export const API_KEY_SCOPES = [
  'sandbox:create',
  'sandbox:read',
  'sandbox:write',
  'exec:create',
  'exec:read',
  'session:create',
  'session:read',
  'session:write',
  'file:read',
  'file:write',
  'artifact:read',
  'artifact:write',
] as const

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number]

/** All available scopes — convenience set for full-access keys. */
export const ALL_SCOPES: readonly ApiKeyScope[] = API_KEY_SCOPES

/** Validates that a string is a known scope. */
export function isValidScope(s: string): s is ApiKeyScope {
  return (API_KEY_SCOPES as readonly string[]).includes(s)
}

/** Parses an array of strings into valid scopes, ignoring unknown ones. */
export function parseScopes(raw: readonly string[]): ApiKeyScope[] {
  return raw.filter(isValidScope)
}

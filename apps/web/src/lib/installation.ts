/**
 * Which repositories Sandchest can see is chosen on GitHub, on the app's installation. Sandchest maps and
 * reviews every one it can see, so it works best given the ones that matter, not a whole account.
 */

/** Past this many repositories on one account, people are asked whether they meant to connect them all. */
export const MANY_REPOS = 50;

/** Where an admin chooses the repositories Sandchest can see, on GitHub. */
export function installationSettingsUrl(org: { login: string; type: "User" | "Organization"; installationId: number | null }): string | null {
  if (!org.installationId) return null;
  return org.type === "Organization"
    ? `https://github.com/organizations/${encodeURIComponent(org.login)}/settings/installations/${org.installationId}`
    : `https://github.com/settings/installations/${org.installationId}`;
}

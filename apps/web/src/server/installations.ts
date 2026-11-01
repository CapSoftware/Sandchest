/**
 * Installations an access refresh finds before GitHub's webhook has recorded
 * them: someone who installs is sent back to the dashboard at once, and the
 * webhook can take a moment longer. Loaded only when that happens, so pages
 * never carry the scan services otherwise.
 */
import type { ListedInstallation } from "@sandchest/github";
import { after } from "next/server";
import { billingEnabled, hasPlan } from "./billing";
import { describeError } from "./log";
import { captureException } from "./sentry";
import { db, githubApp } from "./services";
import { startScan } from "./start";
import { recordInstallation, startRecon } from "./webhooks";

/**
 * Records each installation as its webhook would, and returns the ones now
 * known, so their repositories show on this very page. Recon starts after
 * the response: the page waits for nothing else, and whether the repos show
 * never depends on it. One that fails is logged and left to the webhook. The
 * list comes from the person's own token for this App, so every entry is one
 * of its installations (and recording needs this App's own key besides).
 */
export async function recordListedInstallations(installations: ListedInstallation[]): Promise<Array<{ id: string; installationId: number }>> {
  const deps = { db: db(), github: githubApp(), startScan, hasPlan: billingEnabled() ? hasPlan : undefined };
  const recorded = await Promise.all(
    installations.map(async (installation) => {
      if (installation.account.type === "Bot") return undefined;
      const account = { ...installation.account, type: installation.account.type };
      const org = await recordInstallation(deps, { id: installation.id, account }).catch(logFailure("record"));
      if (!org?.installationId) return undefined;
      later(() => startRecon(deps, org).catch(logFailure("recon")));
      return { id: org.id, installationId: org.installationId };
    }),
  );
  return recorded.filter((org) => org !== undefined);
}

/** After the response when there is one; otherwise (a script, a test) straight away, unawaited. */
function later(task: () => Promise<unknown>): void {
  try {
    after(task);
  } catch {
    void task();
  }
}

function logFailure(what: string) {
  return async (error: unknown): Promise<undefined> => {
    console.error(`Installation ${what} on refresh failed: ${describeError(error)}`);
    await captureException(error, { source: "access", tags: { action: `installation_${what}` }, handled: true });
    return undefined;
  };
}

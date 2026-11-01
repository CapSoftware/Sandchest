/**
 * Billing and operational emails (SPEC §14): credits low or exhausted, auto
 * top-up succeeded or failed, and a scan paused by the model provider's quota.
 *
 * - Credits are watched where Sandchest already learns the balance: after
 *   each reservation, and each time it reads the org from Autumn. That
 *   covers every way the balance falls (only scans spend it) and is
 *   testable without Autumn. Auto top-up results only Autumn knows, so they
 *   arrive by webhook (`autumn-webhooks.ts`).
 * - Every email is reserved in the database before it is sent, so retries
 *   and concurrent callers send it at most once. With nobody to send it to,
 *   nothing is reserved, so a later trigger can still send it once there is.
 * - Recipients are the org's admins, the people who can change its billing,
 *   with a real address (see `recipients`). Billing emails ignore the email
 *   toggle: they are rare by construction and are how an admin learns
 *   reviews are about to stop. The scan-paused email follows the toggle like
 *   other scan emails.
 * - Nothing here logs an address or an email's contents; only opaque ids.
 */
import { CREDIT_LEVELS, creditLevel, planById } from "@sandchest/billing/plans";
import {
  claimNotification,
  claimOrgNotice,
  observeCreditLevel,
  orgAdminContacts,
  raiseCreditLevel,
  type BalanceSeen,
  type OrgAdminContact,
  type OrgBillingRow,
  type OrgSettings,
} from "@sandchest/db";
import { autoTopUpFailedEmail, autoTopUpSucceededEmail, creditsExhaustedEmail, creditsLowEmail, scanPausedEmail, type RenderedEmail } from "@sandchest/email";
import { shortDate } from "@/lib/format";
import { config } from "./config";
import { db } from "./db";
import { githubApp } from "./github-app";
import { mailer } from "./mailer";

export interface NoticeOrg {
  id: string;
  githubLogin: string;
}

type CreditsSnapshot = Pick<OrgBillingRow, "planId" | "credits" | "creditsResetAt" | "autoTopUp">;

/**
 * Checks a balance Sandchest just learned (a reservation's answer, or a read
 * of the org) against the org's plan, and emails the admins once when it
 * crosses down into low or exhausted. A balance back at or above the low line
 * re-arms both, as does a top-up or a renewal. `seen` is when the balance was
 * asked for and answered, so an answer that arrives late changes nothing.
 *
 * With auto top-up on, a low or empty balance is Autumn's to fix and refills a
 * few seconds later, so nothing is announced: if it can't refill, Autumn's
 * auto top-up failed webhook says why.
 *
 * In order: decide whether this is a crossing, from the stored level; only
 * then find who to tell (which may ask GitHub, outside any lock); with nobody,
 * leave the level alone so a later balance can announce it; otherwise commit
 * the crossing, unless someone moved the level meanwhile.
 */
export async function noticeCredits(org: NoticeOrg, billing: CreditsSnapshot, seen: BalanceSeen): Promise<void> {
  const plan = planById(billing.planId);
  if (!plan) return;
  const level = creditLevel(plan, billing.credits);
  const index = CREDIT_LEVELS.indexOf(level);
  const crossing = await observeCreditLevel(db(), org.id, index, seen, { raise: level !== "ok" && !billing.autoTopUp?.enabled });
  if (!crossing) return;
  // Without a mailer the level still moves; there is just nobody to email.
  const to = mailer().enabled ? await recipients(org.id, `${level} credits email`, "billing") : [];
  if (to === null || !(await raiseCreditLevel(db(), org.id, index, seen, crossing)) || to.length === 0) return;
  const input = { org: org.githubLogin, plan: plan.name, resetsOn: billing.creditsResetAt ? shortDate(billing.creditsResetAt) : null, billingUrl: billingUrl() };
  await send(org.id, to, level === "low" ? creditsLowEmail({ ...input, credits: billing.credits }) : creditsExhaustedEmail(input));
}

/** What became of an org-wide email: sent, already sent by an earlier caller, or not sent (and not reserved) for want of a mailer or a recipient. */
export type NoticeOutcome = "sent" | "duplicate" | "skipped";

/** An auto top-up bought credits. Sent once per invoice. */
export async function noticeAutoTopUp(org: NoticeOrg, topUp: { invoiceId: string; added: number; charged: string; credits: number }): Promise<NoticeOutcome> {
  return claimAndSend(org.id, `auto_top_up:${topUp.invoiceId}`, "auto top-up email", () =>
    autoTopUpSucceededEmail({ org: org.githubLogin, added: topUp.added, charged: topUp.charged, credits: topUp.credits, billingUrl: billingUrl() }),
  );
}

/**
 * Auto top-up could not buy credits. Autumn may try again on each scan while
 * the card keeps failing, so this goes out at most once a day per reason.
 */
export async function noticeAutoTopUpFailed(org: NoticeOrg, failure: { reason: "card" | "limit"; credits: number | null }, at = new Date()): Promise<NoticeOutcome> {
  return claimAndSend(org.id, `auto_top_up_failed:${failure.reason}:${at.toISOString().slice(0, 10)}`, "auto top-up failed email", () =>
    autoTopUpFailedEmail({ org: org.githubLogin, reason: failure.reason, credits: failure.credits, billingUrl: billingUrl() }),
  );
}

export interface PausedScan {
  id: string;
  kind: "recon" | "pr_review" | "deep" | "fix_check";
  prNumber: number | null;
  repo: { fullName: string; org: NoticeOrg & { settings: OrgSettings } };
}

/**
 * A scan stopped because the model provider refused for quota. Once per
 * scan, and at most once an hour per org: a provider outage stops every scan
 * in flight, and one email says it. Fix checks run unattended and are skipped.
 */
export async function noticeScanPaused(scan: PausedScan, at = new Date()): Promise<boolean> {
  if (scan.kind === "fix_check") return false;
  const org = scan.repo.org;
  if (org.settings.emailNotifications === false || !mailer().enabled) return false;
  const to = await recipients(org.id, "scan paused email", "fresh");
  if (!to) return false;
  if (!(await claimNotification(db(), scan.id))) return false;
  if (!(await claimOrgNotice(db(), org.id, `scan_paused:${at.toISOString().slice(0, 13)}`))) return false;
  await send(org.id, to, scanPausedEmail({ org: org.githubLogin, repo: scan.repo.fullName, kind: scan.kind, prNumber: scan.prNumber, scanUrl: `${appUrl()}/scans/${scan.id}` }));
  return true;
}

/** Reserves an org-wide email by key and sends it. Without a mailer or anyone to send to, nothing is reserved. */
async function claimAndSend(orgId: string, key: string, what: string, render: () => RenderedEmail): Promise<NoticeOutcome> {
  if (!mailer().enabled) return "skipped";
  const to = await recipients(orgId, what, "billing");
  if (!to) return "skipped";
  if (!(await claimOrgNotice(db(), orgId, key))) return "duplicate";
  await send(orgId, to, render());
  return "sent";
}

/**
 * Who to email, or null (logged by org id) when there is nobody.
 *
 * - `fresh`: admins GitHub confirmed within 30 days, as for finding emails.
 *   The scan-paused email names private repositories and pull requests, so a
 *   former admin must not get it.
 * - `billing`: fresh admins too. When there are none, the stale ones are
 *   checked with GitHub first and only those still admins are emailed. The
 *   answer only chooses this email's recipients: `org_admins` is dashboard
 *   access, and only signing in changes it. If GitHub can't answer, the stale
 *   ones are emailed anyway: billing emails name no repository or finding, and
 *   missing one can stop every review.
 */
async function recipients(orgId: string, what: string, who: "fresh" | "billing"): Promise<string[] | null> {
  const admins = await orgAdminContacts(db(), orgId);
  let chosen = admins.filter((admin) => admin.fresh);
  if (chosen.length === 0 && who === "billing" && admins.length > 0) {
    chosen = await confirmAdmins(orgId, admins).catch((error: unknown) => {
      console.warn(`Couldn't check the admins of org ${orgId} with GitHub (${error instanceof Error ? error.name : "error"}): emailing the last known ones`);
      return admins;
    });
  }
  if (chosen.length > 0) return [...new Set(chosen.map((admin) => admin.email))];
  console.warn(`No admin of org ${orgId} to email: ${what} not sent`);
  return null;
}

/**
 * Asks GitHub which of these admins still are. Read-only. A username can
 * change hands, so a membership counts only if it belongs to the same GitHub
 * account (`github_user_id`). Throws when GitHub can't say.
 */
async function confirmAdmins(orgId: string, admins: OrgAdminContact[]): Promise<OrgAdminContact[]> {
  const org = await db().query.orgs.findFirst({ where: (orgs, { eq }) => eq(orgs.id, orgId), columns: { type: true, githubLogin: true, githubAccountId: true, installationId: true } });
  if (!org) return [];
  // A personal account has one admin: its owner.
  if (org.type === "User") return admins.filter((admin) => admin.githubUserId === org.githubAccountId);
  if (!org.installationId) throw new Error("The app is no longer installed");
  const installation = githubApp().installation(org.installationId);
  const still = await Promise.all(
    admins.map(async (admin) => {
      if (!admin.login || admin.githubUserId === null) return false;
      const membership = await installation.orgMembership(org.githubLogin, admin.login);
      return membership?.userId === admin.githubUserId && membership.state === "active" && membership.role === "admin";
    }),
  );
  return admins.filter((_, index) => still[index]);
}

/** Best effort: the email is already reserved, so a failure is logged (by error name: SMTP errors can quote addresses), not retried. */
async function send(orgId: string, to: string[], email: RenderedEmail): Promise<void> {
  await mailer()
    .send({ to, ...email })
    .catch((error: unknown) => console.error(`Email to the admins of org ${orgId} failed: ${error instanceof Error ? error.name : "error"}`));
}

function appUrl(): string {
  return config().SANDCHEST_APP_URL.replace(/\/$/, "");
}

function billingUrl(): string {
  return `${appUrl()}/settings#billing`;
}

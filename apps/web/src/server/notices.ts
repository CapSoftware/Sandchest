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
 *   and concurrent callers send it at most once.
 * - Recipients are the org's admins, the people who can change its billing,
 *   with a real address. Billing emails ignore the email toggle: they are
 *   rare by construction and are how an admin learns reviews are about to
 *   stop. The scan-paused email follows the toggle like other scan emails.
 * - Nothing here logs an address or an email's contents.
 */
import { CREDIT_LEVELS, creditLevel, planById } from "@sandchest/billing/plans";
import { billingRecipients, claimNotification, claimOrgNotice, recordCreditLevel, type OrgBillingRow, type OrgSettings } from "@sandchest/db";
import { autoTopUpFailedEmail, autoTopUpSucceededEmail, creditsExhaustedEmail, creditsLowEmail, scanPausedEmail, type RenderedEmail } from "@sandchest/email";
import { shortDate } from "@/lib/format";
import { config } from "./config";
import { db } from "./db";
import { mailer } from "./mailer";

export interface NoticeOrg {
  id: string;
  githubLogin: string;
}

type CreditsSnapshot = Pick<OrgBillingRow, "planId" | "credits" | "creditsResetAt" | "autoTopUp">;

/**
 * Checks a balance Sandchest just learned against the org's plan, and emails
 * the admins once when it crosses down into low or exhausted. A balance back
 * at or above the low line re-arms both, as does a top-up or a renewal.
 *
 * Where the balance came from matters:
 * - `reserve`: what a reservation left. Only scans spend credits, so this can
 *   announce a crossing but never re-arm one (concurrent scans answer out of
 *   order). With auto top-up on, Autumn refills a few seconds later, so it
 *   announces nothing then.
 * - `read`: Autumn's balance, from a request that started at `asOf`. It can
 *   re-arm, if it started after the last crossing was announced.
 * With auto top-up on, "low" is its job and is never announced; "exhausted"
 * read from Autumn means it did not refill, and is.
 */
export async function noticeCredits(org: NoticeOrg, billing: CreditsSnapshot, seen: { source: "reserve" } | { source: "read"; asOf: Date }): Promise<void> {
  const plan = planById(billing.planId);
  if (!plan) return;
  const level = creditLevel(plan, billing.credits);
  const autoTopUp = !!billing.autoTopUp?.enabled;
  const raise = !(autoTopUp && (level === "low" || seen.source === "reserve"));
  const lowerAsOf = seen.source === "read" ? seen.asOf : undefined;
  if (!(await recordCreditLevel(db(), org.id, CREDIT_LEVELS.indexOf(level), { raise, lowerAsOf }))) return;
  const input = { org: org.githubLogin, plan: plan.name, resetsOn: billing.creditsResetAt ? shortDate(billing.creditsResetAt) : null, billingUrl: billingUrl() };
  await sendToAdmins(org.id, level === "low" ? creditsLowEmail({ ...input, credits: billing.credits }) : creditsExhaustedEmail({ ...input, autoTopUp }));
}

/** An auto top-up bought credits. Sent once per invoice. */
export async function noticeAutoTopUp(org: NoticeOrg, topUp: { invoiceId: string; added: number; charged: string; credits: number }): Promise<boolean> {
  if (!(await claimOrgNotice(db(), org.id, `auto_top_up:${topUp.invoiceId}`))) return false;
  await sendToAdmins(org.id, autoTopUpSucceededEmail({ org: org.githubLogin, added: topUp.added, charged: topUp.charged, credits: topUp.credits, billingUrl: billingUrl() }));
  return true;
}

/**
 * Auto top-up could not buy credits. Autumn may try again on each scan while
 * the card keeps failing, so this goes out at most once a day per reason.
 */
export async function noticeAutoTopUpFailed(org: NoticeOrg, failure: { reason: "card" | "limit"; credits: number | null }, at = new Date()): Promise<boolean> {
  if (!(await claimOrgNotice(db(), org.id, `auto_top_up_failed:${failure.reason}:${at.toISOString().slice(0, 10)}`))) return false;
  await sendToAdmins(org.id, autoTopUpFailedEmail({ org: org.githubLogin, reason: failure.reason, credits: failure.credits, billingUrl: billingUrl() }));
  return true;
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
  if (!(await claimNotification(db(), scan.id))) return false;
  if (!(await claimOrgNotice(db(), org.id, `scan_paused:${at.toISOString().slice(0, 13)}`))) return false;
  await sendToAdmins(org.id, scanPausedEmail({ org: org.githubLogin, repo: scan.repo.fullName, kind: scan.kind, prNumber: scan.prNumber, scanUrl: `${appUrl()}/scans/${scan.id}` }));
  return true;
}

/** Best effort: the email is already reserved, so a failure is logged (by error name: SMTP errors can quote addresses), not retried. */
async function sendToAdmins(orgId: string, email: RenderedEmail): Promise<void> {
  if (!mailer().enabled) return;
  const to = await billingRecipients(db(), orgId);
  if (to.length === 0) return;
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

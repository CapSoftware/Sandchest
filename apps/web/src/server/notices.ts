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
 *   with a real address. Billing emails ignore the email toggle: they are
 *   rare by construction and are how an admin learns reviews are about to
 *   stop. The scan-paused email follows the toggle like other scan emails.
 * - Nothing here logs an address or an email's contents; only opaque ids.
 */
import { CREDIT_LEVELS, creditLevel, planById } from "@sandchest/billing/plans";
import { billingRecipients, claimNotification, claimOrgNotice, recordCreditLevel, type BalanceSeen, type OrgBillingRow, type OrgSettings } from "@sandchest/db";
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
 * Checks a balance Sandchest just learned (a reservation's answer, or a read
 * of the org) against the org's plan, and emails the admins once when it
 * crosses down into low or exhausted. A balance back at or above the low line
 * re-arms both, as does a top-up or a renewal. `seen` is when the balance was
 * asked for and answered, so an answer that arrives late changes nothing.
 *
 * With auto top-up on, a low or empty balance is Autumn's to fix and refills a
 * few seconds later, so nothing is announced: if it can't refill, Autumn's
 * auto top-up failed webhook says why.
 */
export async function noticeCredits(org: NoticeOrg, billing: CreditsSnapshot, seen: BalanceSeen): Promise<void> {
  const plan = planById(billing.planId);
  if (!plan) return;
  const level = creditLevel(plan, billing.credits);
  let raise = level !== "ok" && !billing.autoTopUp?.enabled;
  // Nobody to tell: leave the level where it is, so the crossing is announced once someone is.
  const to = raise && mailer().enabled ? await recipients(org.id, `${level} credits email`) : [];
  if (to === null) raise = false;
  if (!(await recordCreditLevel(db(), org.id, CREDIT_LEVELS.indexOf(level), seen, { raise })) || !to?.length) return;
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
  const to = await recipients(org.id, "scan paused email");
  if (!to) return false;
  if (!(await claimNotification(db(), scan.id))) return false;
  if (!(await claimOrgNotice(db(), org.id, `scan_paused:${at.toISOString().slice(0, 13)}`))) return false;
  await send(org.id, to, scanPausedEmail({ org: org.githubLogin, repo: scan.repo.fullName, kind: scan.kind, prNumber: scan.prNumber, scanUrl: `${appUrl()}/scans/${scan.id}` }));
  return true;
}

/** Reserves an org-wide email by key and sends it. Without a mailer or anyone to send to, nothing is reserved. */
async function claimAndSend(orgId: string, key: string, what: string, render: () => RenderedEmail): Promise<NoticeOutcome> {
  if (!mailer().enabled) return "skipped";
  const to = await recipients(orgId, what);
  if (!to) return "skipped";
  if (!(await claimOrgNotice(db(), orgId, key))) return "duplicate";
  await send(orgId, to, render());
  return "sent";
}

/** The org's admins with an address, or null (logged by org id) when there are none. */
async function recipients(orgId: string, what: string): Promise<string[] | null> {
  const to = await billingRecipients(db(), orgId);
  if (to.length > 0) return to;
  console.warn(`No admin of org ${orgId} has an email address: ${what} not sent`);
  return null;
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

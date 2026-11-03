/**
 * Free credits from `/claim`: FREE_CREDITS.credits for one account, with no
 * card. The account gets them as a one-off Autumn grant plus the free plan,
 * which lets it scan like any other until the credits are spent. Then every
 * scan stops (see `reserveScan`) until it joins Standard, which takes a card
 * and keeps whatever free credits are left.
 *
 * Who can claim:
 * - an admin of an installed account that has never had a plan;
 * - once per GitHub account and once per GitHub user, ever, keyed by GitHub's
 *   ids (`credit_claims`), so reinstalling or switching accounts can't repeat it;
 * - while fewer than FREE_CREDITS.claims have been made.
 *
 * Every step is safe to repeat: the claim row is taken first, the grant is
 * one balance under a fixed id, and the free plan is attached only while the
 * account has no plan. A claim that dies half way is finished by trying again.
 */
import { AutumnError, FREE_CREDITS, isTrial, TRIAL } from "@sandchest/billing";
import { adminOrgs, creditClaimState, finishCreditClaim, orgBillingRow, orgForAdmin, startCreditClaim } from "@sandchest/db";
import { cookies } from "next/headers";
import { CLAIM_COOKIE, type ClaimClosed, type ClaimIntent, type ClaimOffer } from "@/lib/free-credits";
import { autumn, billingEnabled, syncBilling } from "./billing";
import { config } from "./config";
import { db } from "./db";
import { describeError } from "./log";
import { captureException } from "./sentry";

/**
 * What claiming would do for each account this person administers. Read from
 * the stored billing copy; the claim itself checks Autumn again.
 */
export async function claimOffers(user: { id: string; githubUserId: number | null }): Promise<Record<string, ClaimOffer>> {
  if (!billingEnabled()) return {};
  const accounts = await adminOrgs(db(), user.id);
  const { claims, total } = await creditClaimState(
    db(),
    accounts.map((account) => account.githubAccountId),
    user.githubUserId,
  );
  const mine = user.githubUserId === null ? undefined : claims.find((claim) => claim.githubUserId === user.githubUserId);
  const offers: Record<string, ClaimOffer> = {};
  for (const account of accounts) {
    const own = mine?.githubAccountId === account.githubAccountId;
    offers[account.id] = own
      ? // Their own claim: open until it's finished, so a half-done one can be completed.
        mine!.grantedAt
        ? { open: false, reason: "claimed_elsewhere", login: account.login }
        : { open: true, credits: FREE_CREDITS.credits }
      : claims.some((claim) => claim.githubAccountId === account.githubAccountId)
        ? { open: false, reason: "org_claimed" }
        : mine
          ? { open: false, reason: "claimed_elsewhere", login: accounts.find((a) => a.githubAccountId === mine.githubAccountId)?.login ?? null }
          : account.planId || account.activatedAt
            ? { open: false, reason: "has_plan" }
            : total >= FREE_CREDITS.claims
              ? { open: false, reason: "exhausted" }
              : { open: true, credits: FREE_CREDITS.credits };
  }
  return offers;
}

/**
 * The recruit flow's free credits: set when the person came from `/claim`
 * (the cookie) and billing is on, with what each of their accounts can claim.
 */
export async function claimIntent(user: { id: string; githubUserId: number | null } | null): Promise<ClaimIntent | null> {
  if (!billingEnabled() || (await cookies()).get(CLAIM_COOKIE)?.value !== "1") return null;
  return { credits: FREE_CREDITS.credits, offers: user ? await claimOffers(user) : {} };
}

export type ClaimResult = { ok: true } | ({ ok: false } & (ClaimClosed | { reason: "not_admin" | "no_github_id" | "failed" }));

/**
 * Claims the free credits for an org this person administers: the claim row,
 * then Autumn's grant and the free plan. Starts recon (through the plan's
 * first sync) but not the first Dig: the caller does that.
 */
export async function claimFreeCredits(user: { id: string; githubUserId: number | null }, orgId: string): Promise<ClaimResult> {
  const client = autumn();
  if (!client) return { ok: false, reason: "failed" };
  if (user.githubUserId === null) return { ok: false, reason: "no_github_id" };
  const row = await orgForAdmin(db(), user.id, orgId);
  if (!row) return { ok: false, reason: "not_admin" };
  const { org } = row;
  try {
    // Autumn's word on the plan, not the stored copy: it creates the customer too.
    const before = await syncBilling(org);
    const { claims } = await creditClaimState(db(), [org.githubAccountId], user.githubUserId);
    const own = claims.find((claim) => claim.githubAccountId === org.githubAccountId && claim.githubUserId === user.githubUserId);
    // A finished claim is never run again: only an unfinished one is resumed. (Re-running it after a paid plan
    // lapsed would put the account back on the free plan.) Still on the free plan from it: nothing to do.
    if (own?.grantedAt) {
      // Asked again: a double click's other half may have read the plan before this claim attached it.
      const now = isTrial(before.planId) ? before.planId : (await client.customer(org.id)).planId;
      return isTrial(now) ? { ok: true } : { ok: false, reason: "claimed_elsewhere", login: org.githubLogin };
    }
    if (!own) {
      // Someone's claim first: it says more than "has a plan", which the claim itself brought.
      if (claims.some((claim) => claim.githubAccountId === org.githubAccountId)) return { ok: false, reason: "org_claimed" };
      const elsewhere = claims.find((claim) => claim.githubUserId === user.githubUserId);
      if (elsewhere) return { ok: false, reason: "claimed_elsewhere", login: await claimedLogin(user.id, elsewhere.githubAccountId) };
      // A plan now, or ever (a cancelled one leaves `activated_at`), rules a first claim out.
      const stored = await orgBillingRow(db(), org.id);
      if (before.planId || stored?.activatedAt) return { ok: false, reason: "has_plan" };
    }
    const start = await startCreditClaim(
      db(),
      { githubAccountId: org.githubAccountId, githubUserId: user.githubUserId, orgId: org.id, userId: user.id, credits: FREE_CREDITS.credits },
      FREE_CREDITS.claims,
    );
    if (start === "org_claimed" || start === "exhausted") return { ok: false, reason: start };
    if (start === "user_claimed") {
      const mine = (await creditClaimState(db(), [], user.githubUserId)).claims[0];
      return { ok: false, reason: "claimed_elsewhere", login: mine ? await claimedLogin(user.id, mine.githubAccountId) : null };
    }

    await client.grant({ customerId: org.id, credits: FREE_CREDITS.credits, balanceId: FREE_CREDITS.balanceId });
    // Only onto no plan at all: attaching it over a paid plan would replace that plan. Autumn is asked again
    // right before, so a plan bought in another tab while this claim ran is never replaced.
    if (!before.planId && !(await client.customer(org.id)).planId) {
      try {
        const { paymentUrl } = await client.attach({ customerId: org.id, planId: TRIAL.id, successUrl: `${config().SANDCHEST_APP_URL.replace(/\/$/, "")}/dashboard` });
        // A free plan never asks for payment. If it ever did, nothing is attached: stop rather than send them to pay.
        if (paymentUrl) throw new Error("the free plan asked for payment");
      } catch (error) {
        // A retried claim whose plan went through the first time.
        if (!(error instanceof AutumnError && error.code === "plan_already_attached")) throw error;
      }
    }
    await finishCreditClaim(db(), org.githubAccountId);

    // The plan shows at once in Autumn; the sync stores it and starts recon on every repository. The claim is
    // done either way: if the plan is slow to show, the next page view's sync finds it.
    let state = await syncBilling(org).catch(() => null);
    for (let attempt = 0; !state?.planId && attempt < 5; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 600));
      state = await syncBilling(org).catch(() => state);
    }
    return { ok: true };
  } catch (error) {
    console.error(`Free credits for org ${org.id} failed: ${describeError(error)}`);
    await captureException(error, { source: "billing", tags: { action: "claim" }, handled: true });
    return { ok: false, reason: "failed" };
  }
}

/** The login of the account a person claimed for, if they still administer it. */
async function claimedLogin(userId: string, githubAccountId: number): Promise<string | null> {
  return (await adminOrgs(db(), userId)).find((account) => account.githubAccountId === githubAccountId)?.login ?? null;
}

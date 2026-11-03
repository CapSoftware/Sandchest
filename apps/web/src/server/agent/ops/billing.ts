/**
 * Plans and credits, as an agent sees and spends them. The rules are the
 * dashboard's: the first plan is paid on Stripe (a link for the person, since
 * card details never pass through an agent), and once a card is on file
 * credits are charged to it directly. Free credits need no card at all.
 */
import { CREDIT_TIERS, defaultAutoTopUpLimit, FREE_CREDITS, isTrial, MAX_PURCHASE_CREDITS, PLAN, TOP_UP, TOP_UP_BELOW } from "@sandchest/billing/plans";
import { DEEP_SCAN_TIERS, PR_REVIEW_TIERS } from "@sandchest/billing/costs";
import { AutumnError, StripeError, type BillingState } from "@sandchest/billing";
import { updateOrgSettings, type OrgBillingRow } from "@sandchest/db";
import { z } from "zod";
import { closedMessage, type ClaimOffer } from "@/lib/free-credits";
import { track } from "../../analytics";
import { autumn, billingEnabled, saveAutoTopUpChoice, stripe, syncBilling } from "../../billing";
import { db } from "../../db";
import { codeOffer, claimFreeCredits, claimOffers } from "../../free-credits";
import { applyInvoiceDetails, InvoiceDetails } from "../../invoice-details";
import { describeError } from "../../log";
import { captureException } from "../../sentry";
import { ApiError } from "../errors";
import { AccountRef, flag, int, operation, type Context } from "../operation";
import { resolveAccount, resolveAdminAccount } from "../resolve";
import { iso, planView } from "../views";

const PromotionCode = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{1,64}$/)
  .describe("A promotion code, if the person has one. A free-credit code claims free credits instead of charging.");
const Credits = int(1, MAX_PURCHASE_CREDITS).describe(`How many credits to buy (1-${MAX_PURCHASE_CREDITS}). Credits are $1 each, less in bigger purchases.`);

function requireBilling(): void {
  if (!billingEnabled()) throw new ApiError(400, "billing_disabled", "Billing is off on this deployment (self-hosted): nothing is limited and there is nothing to buy.");
}

/** Billing errors: logged without their message (it can quote customer details), reported, and answered generically. */
async function billingFailure(action: string, orgId: string, error: unknown): Promise<never> {
  console.error(`Agent billing ${action} for org ${orgId} failed: ${describeError(error)}`);
  await captureException(error, { source: "billing", tags: { action: `agent_${action}` }, handled: true });
  throw new ApiError(502, "billing_unavailable", "Billing didn't answer just now, and nothing was charged. Try again in a minute.");
}

type State = Pick<BillingState, "pastDue" | "endsAt" | "renewsAt" | "autoTopUp"> & { planId: string | null; credits: number; creditsResetAt: Date | null };

const fromRow = (row: OrgBillingRow): State => ({ ...row, credits: row.credits, creditsResetAt: row.creditsResetAt });

function billingView(context: Context, org: { id: string; login: string; admin: boolean; autoTopUp?: { quantity?: number; monthlyLimitUsd: number; enabled: boolean } }, state: State | null, offer: { open: boolean; credits?: number; reason?: string } | null) {
  const paid = !!state?.planId && !isTrial(state.planId);
  return {
    account: { id: org.id, login: org.login, admin: org.admin },
    plan: planView(state?.planId),
    card_on_file: paid,
    credits: state?.credits ?? 0,
    credits_reset_at: iso(state?.creditsResetAt),
    renews_at: iso(state?.renewsAt),
    ends_at: iso(state?.endsAt),
    past_due: state?.pastDue ?? false,
    auto_top_up: state?.autoTopUp?.enabled
      ? { enabled: true, buys_credits: state.autoTopUp.quantity, when_below: state.autoTopUp.threshold, times_per_month_max: state.autoTopUp.perMonth, monthly_limit_usd: org.autoTopUp?.monthlyLimitUsd ?? null }
      : { enabled: false },
    free_credits: offer,
    how_to_pay: !state?.planId
      ? `No plan yet, so nothing scans. ${offer?.open ? "Call claim_free_credits for free credits (no card), or " : "Call "}buy_credits: the first purchase joins the ${PLAN.name} plan ($${PLAN.price}/month) and returns a Stripe Checkout link for the person to pay.`
      : paid
        ? "buy_credits charges the card on file at once. set_auto_top_up buys more automatically when credits run low."
        : `On free credits. buy_credits joins ${PLAN.name} with a card (a Stripe Checkout link for the person); credits left over carry across.`,
    prices: {
      plan: { id: PLAN.id, usd_per_month: PLAN.price },
      credit_usd_by_purchase_size: CREDIT_TIERS.map((tier) => ({ from_credits: tier.from, usd_per_credit: tier.price })),
      deep_scan_credits_by_lines_of_code: DEEP_SCAN_TIERS.map((tier) => ({ below_loc: Number.isFinite(tier.maxLoc) ? tier.maxLoc : null, credits: tier.credits })),
      pr_review_credits_by_changed_lines: PR_REVIEW_TIERS.map((tier) => ({ up_to_lines: Number.isFinite(tier.maxLines) ? tier.maxLines : null, credits: tier.credits })),
      free: ["recon (mapping each repository)", "fix checks (pushes to the default branch)", "each account's first deep scan"],
    },
    links: { settings: `${context.appUrl}/dashboard/settings#billing` },
  };
}

/** Free credits as the API says it: open with how many, or closed with why. Admins only (only they can claim). */
async function offerFor(context: Context, org: { id: string; login: string; admin: boolean }) {
  if (!org.admin) return null;
  const offers = await claimOffers({ id: context.principal.userId, githubUserId: context.principal.githubUserId }).catch((): Record<string, ClaimOffer> => ({}));
  const offer = offers[org.id];
  if (!offer) return null;
  return offer.open ? { open: true, credits: offer.credits } : { open: false, reason: offer.reason, message: closedMessage(offer, org.login) };
}

/** Where Stripe sends the person back to: the dashboard reads the payment and starts scanning. */
const returnUrl = (context: Context, orgId: string) => `${context.appUrl}/dashboard/billing/return?org=${orgId}`;

export const billingOps = [
  operation({
    name: "get_billing",
    title: "Get billing",
    description:
      "An account's plan, credits, auto top-up, whether a card is on file, free credits it can claim, and the price list (credits per deep scan and PR review). Read live from billing, so call it after the person pays to see the plan take effect.",
    method: "GET",
    path: "/accounts/{account}/billing",
    input: z.object({
      account: AccountRef,
      wait: int(0, 50).optional().describe("Seconds to wait for a paid plan to take effect while the person pays on Stripe (re-reading billing every few seconds)."),
    }),
    readOnly: true,
    openWorld: true,
    async run(context, input) {
      requireBilling();
      const org = await resolveAccount(context, input.account);
      const read = () =>
        syncBilling({ id: org.id, githubLogin: org.login })
          .then(fromRow)
          .catch(() => (org.billing ? fromRow(org.billing) : null));
      let [state, offer] = await Promise.all([read(), offerFor(context, org)]);
      const paid = (s: State | null) => !!s?.planId && !isTrial(s.planId);
      const until = Date.now() + (input.wait ?? 0) * 1_000;
      while (!paid(state) && Date.now() + 3_000 < until) {
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        state = await read();
      }
      return billingView(context, { ...org, autoTopUp: org.settings.autoTopUp }, state, offer);
    },
  }),

  operation({
    name: "quote_credits",
    title: "Price a credit purchase",
    description: "Prices buying credits for an account without charging anything: what's due now (with any promotion code), and whether it would charge the card on file or need the person to pay on Stripe Checkout. Admins only.",
    method: "POST",
    path: "/accounts/{account}/billing/quote",
    input: z.object({ account: AccountRef, credits: Credits, promotion_code: PromotionCode.optional() }),
    readOnly: true,
    openWorld: true,
    async run(context, input) {
      requireBilling();
      const row = await resolveAdminAccount(context, input.account);
      const user = { id: context.principal.userId, githubUserId: context.principal.githubUserId };
      if (input.promotion_code) {
        const offer = await codeOffer(user, row.org.id, input.promotion_code);
        if (offer) {
          if (!offer.open) throw new ApiError(409, `free_credits_${offer.reason}`, closedMessage(offer, row.org.githubLogin));
          return { free_credits: offer.credits, due_today_usd: 0, note: "This is a free-credit code: call claim_free_credits with it. No card needed." };
        }
      }
      try {
        const { planId } = await syncBilling(row.org);
        const joining = !planId || isTrial(planId);
        const preview = await autumn()!.preview({ customerId: row.org.id, planId: joining ? PLAN.id : TOP_UP.id, credits: input.credits, promotionCode: input.promotion_code });
        return {
          credits: input.credits,
          due_today_usd: preview.dueToday,
          discount_usd: preview.discount,
          ...(joining && { joins_plan: { id: PLAN.id, usd_per_month: PLAN.price, next_charge_usd: preview.nextCycle, next_charge_at: iso(preview.nextCycleAt) } }),
          payment: joining ? "checkout" : "card_on_file",
          note: joining ? "buy_credits will return a Stripe Checkout link for the person to pay." : "buy_credits will charge the card on file at once.",
        };
      } catch (error) {
        if (error instanceof AutumnError && error.status >= 400 && error.status < 500 && input.promotion_code) {
          throw new ApiError(422, "invalid_promotion_code", "That promotion code isn't valid, or has expired.");
        }
        return billingFailure("quote", row.org.id, error);
      }
    },
  }),

  operation({
    name: "buy_credits",
    title: "Buy credits",
    description:
      "Buys credits for an account (admins only). With a card on file it charges it at once and returns the new balance. Without one (no plan yet, or on free credits), it joins the plan with these credits and returns `checkout_url`: give it to the person to pay on Stripe, then call get_billing with wait=50 until the plan shows. A card that needs an extra check (3-D Secure) also returns a URL for the person. Pass max_usd to refuse anything dearer than you expect.",
    method: "POST",
    path: "/accounts/{account}/billing/purchase",
    input: z.object({
      account: AccountRef,
      credits: Credits,
      promotion_code: PromotionCode.optional(),
      max_usd: z.number().positive().max(100_000).optional().describe("Refuse (charging nothing) if this purchase would cost more than this many USD."),
      auto_top_up: flag().optional().describe("On a first purchase: also buy this many credits again automatically whenever fewer than 5 are left (up to a monthly limit)."),
    }),
    openWorld: true,
    async run(context, input) {
      requireBilling();
      const row = await resolveAdminAccount(context, input.account);
      const user = { id: context.principal.userId, githubUserId: context.principal.githubUserId };
      if (input.promotion_code && (await codeOffer(user, row.org.id, input.promotion_code))) {
        throw new ApiError(409, "free_credit_code", "That's a free-credit code: call claim_free_credits with it instead. Nothing was charged.");
      }
      const props = (outcome: string, route: string | null = null) => ({ kind: "top_up", plan: null, credits: input.credits, route, outcome, via: context.surface });
      let planId: string | null;
      try {
        ({ planId } = await syncBilling(row.org));
      } catch (error) {
        return billingFailure("read", row.org.id, error);
      }
      const joining = !planId || isTrial(planId);
      if (input.max_usd !== undefined) {
        const preview = await autumn()!
          .preview({ customerId: row.org.id, planId: joining ? PLAN.id : TOP_UP.id, credits: input.credits, promotionCode: input.promotion_code })
          .catch((error) => billingFailure("quote", row.org.id, error));
        if (preview.dueToday > input.max_usd) {
          await track("purchase_started", { userId: user.id, orgId: row.org.id, props: props("over_max") });
          throw new ApiError(409, "over_max_usd", `This purchase costs $${preview.dueToday.toFixed(2)} now, more than max_usd ($${input.max_usd}). Nothing was charged.`, { due_today_usd: preview.dueToday });
        }
      }
      if (joining && input.auto_top_up !== undefined) {
        await updateOrgSettings(db(), user.id, row.org.id, { autoTopUp: { enabled: input.auto_top_up, quantity: input.credits, monthlyLimitUsd: defaultAutoTopUpLimit(input.credits) } });
      }
      let paymentUrl: string | null;
      try {
        ({ paymentUrl } = await autumn()!.attach({
          customerId: row.org.id,
          planId: joining ? PLAN.id : TOP_UP.id,
          credits: input.credits,
          promotionCode: input.promotion_code,
          successUrl: returnUrl(context, row.org.id),
        }));
      } catch (error) {
        await track("purchase_confirmed", { userId: user.id, orgId: row.org.id, props: props("checkout_failed") });
        if (error instanceof AutumnError && error.status >= 400 && error.status < 500 && input.promotion_code) {
          throw new ApiError(422, "invalid_promotion_code", "That promotion code isn't valid for this purchase. Nothing was charged.");
        }
        // Once the charge was asked for it may have gone through: never invite a blind retry.
        console.error(`Agent billing purchase for org ${row.org.id} failed: ${describeError(error)}`);
        await captureException(error, { source: "billing", tags: { action: "agent_purchase" }, handled: true });
        throw new ApiError(
          502,
          "billing_unknown",
          "Billing didn't confirm this purchase, so it may or may not have been charged. Call get_billing and check the credits before buying again.",
        );
      }
      await track("purchase_confirmed", { userId: user.id, orgId: row.org.id, props: props("ok", paymentUrl ? "stripe" : "charged") });
      if (paymentUrl) {
        return {
          status: joining ? "checkout_required" : "action_required",
          checkout_url: paymentUrl,
          message: joining
            ? `Give the person this link to pay on Stripe. It joins ${row.org.githubLogin} to the ${PLAN.name} plan ($${PLAN.price}/month) with ${input.credits} credits; the card is then saved for later purchases. Then call get_billing with wait=50 until plan is set.`
            : "The card needs an extra check. Give the person this link to finish the payment, then call get_billing with wait=50.",
        };
      }
      const state = await syncBilling(row.org).catch(() => null);
      return { status: "charged", credits: state?.credits ?? null, plan: planView(state?.planId ?? planId), message: `Charged. ${row.org.githubLogin} now has ${state?.credits ?? "more"} credits.` };
    },
  }),

  operation({
    name: "claim_free_credits",
    title: "Claim free credits",
    description: `Claims ${FREE_CREDITS.credits} free credits for an account, with no card (admins only). Once per GitHub account and once per person, for accounts that have never had a plan, while the offer lasts. Starts mapping the account's repositories straight away.`,
    method: "POST",
    path: "/accounts/{account}/billing/claim",
    input: z.object({ account: AccountRef, code: PromotionCode.optional().describe("A free-credit code, if the person was given one.") }),
    openWorld: true,
    async run(context, input) {
      requireBilling();
      const row = await resolveAdminAccount(context, input.account);
      const user = { id: context.principal.userId, githubUserId: context.principal.githubUserId };
      if (input.code && !(await codeOffer(user, row.org.id, input.code))) throw new ApiError(422, "invalid_code", "That isn't a free-credit code. If it's a promotion code, pass it to buy_credits.");
      const result = await claimFreeCredits(user, row.org.id);
      await track("free_credits_claimed", { userId: user.id, orgId: row.org.id, props: { outcome: result.ok ? "ok" : result.reason, via: context.surface } });
      if (!result.ok) {
        switch (result.reason) {
          case "not_admin":
            throw new ApiError(403, "not_admin", `Only an admin of ${row.org.githubLogin} can claim its free credits.`);
          case "failed":
          case "no_github_id":
            throw new ApiError(502, "claim_failed", "The free credits couldn't be added just now, and nothing was charged. Try again in a minute.");
          default:
            throw new ApiError(409, `free_credits_${result.reason}`, closedMessage(result, row.org.githubLogin));
        }
      }
      const state = await syncBilling(row.org).catch(() => null);
      return {
        status: "claimed",
        credits: state?.credits ?? FREE_CREDITS.credits,
        plan: planView(state?.planId),
        message: "Claimed. Recon is mapping the account's repositories now (free); start_deep_scan runs a full scan, and the account's first one is free.",
      };
    },
  }),

  operation({
    name: "set_auto_top_up",
    title: "Set auto top-up",
    description: `Turns auto top-up on or off for an account on a paid plan (admins only): when fewer than ${TOP_UP_BELOW} credits are left, buy \`credits\` more on the card on file, spending at most monthly_limit_usd a month.`,
    method: "PUT",
    path: "/accounts/{account}/billing/auto-top-up",
    input: z.object({
      account: AccountRef,
      enabled: flag(),
      credits: Credits.optional().describe("How many credits each top-up buys. Default: the last choice, else 10."),
      monthly_limit_usd: z.number().int().min(1).max(100_000).optional().describe("The most auto top-up may spend in a month. Default: five top-ups' worth, at least $50."),
    }),
    idempotent: true,
    openWorld: true,
    async run(context, input) {
      requireBilling();
      const row = await resolveAdminAccount(context, input.account);
      const choiceIn = { enabled: input.enabled, quantity: input.credits, monthlyLimitUsd: input.monthly_limit_usd };
      let result: Awaited<ReturnType<typeof saveAutoTopUpChoice>>;
      try {
        result = await saveAutoTopUpChoice(context.principal.userId, row, choiceIn);
      } catch (error) {
        await track("auto_top_up_saved", { userId: context.principal.userId, orgId: row.org.id, props: { enabled: input.enabled, quantity: input.credits ?? null, monthly_limit_usd: input.monthly_limit_usd ?? null, outcome: "error", via: context.surface } });
        return billingFailure("auto_top_up", row.org.id, error);
      }
      if (!result.ok) {
        if (result.reason === "not_admin") throw new ApiError(403, "not_admin", `Only an admin of ${row.org.githubLogin} can change its billing.`);
        throw new ApiError(409, "needs_paid_plan", `Auto top-up charges a card, so ${row.org.githubLogin} needs to join the ${PLAN.name} plan first (buy_credits).`);
      }
      await track("auto_top_up_saved", {
        userId: context.principal.userId,
        orgId: row.org.id,
        props: { enabled: result.choice.enabled, quantity: result.choice.quantity ?? null, monthly_limit_usd: result.choice.monthlyLimitUsd, outcome: "ok", via: context.surface },
      });
      return { auto_top_up: { enabled: result.choice.enabled, credits: result.choice.quantity, monthly_limit_usd: result.choice.monthlyLimitUsd, when_below: TOP_UP_BELOW } };
    },
  }),

  operation({
    name: "open_billing_portal",
    title: "Billing portal link",
    description: "A link to Stripe's billing portal for an account (admins only), for the person to change the card, download invoices or cancel. The link is short-lived: give it to the person straight away.",
    method: "POST",
    path: "/accounts/{account}/billing/portal",
    input: z.object({ account: AccountRef }),
    readOnly: true,
    openWorld: true,
    async run(context, input) {
      requireBilling();
      const row = await resolveAdminAccount(context, input.account);
      if (!row.billing?.planId || isTrial(row.billing.planId)) throw new ApiError(409, "no_card", `${row.org.githubLogin} has no card on file yet, so there's no billing portal. buy_credits joins the plan.`);
      try {
        const url = await autumn()!.portal(row.org.id, returnUrl(context, row.org.id));
        await track("billing_portal_opened", { userId: context.principal.userId, orgId: row.org.id, props: { outcome: "ok", via: context.surface } });
        return { url };
      } catch (error) {
        await track("billing_portal_opened", { userId: context.principal.userId, orgId: row.org.id, props: { outcome: "error", via: context.surface } });
        return billingFailure("portal", row.org.id, error);
      }
    },
  }),

  operation({
    name: "set_invoice_details",
    title: "Set invoice details",
    description: "Sets the business name, address and optional tax ID (e.g. eu_vat, gb_vat, us_ein) shown on an account's invoices (admins only). Best done before the first purchase, so its invoice carries them.",
    method: "PUT",
    path: "/accounts/{account}/billing/invoice-details",
    input: z.object({
      account: AccountRef,
      name: z.string().trim().min(1).max(256),
      address: z.object({
        line1: z.string().trim().min(1).max(200),
        line2: z.string().trim().max(200).nullish(),
        city: z.string().trim().max(200),
        state: z.string().trim().max(200).nullish(),
        postal_code: z.string().trim().max(40),
        country: z.string().regex(/^[A-Z]{2}$/).describe("Two-letter country code, e.g. US, GB, DE."),
      }),
      tax_id: z.object({ type: z.string().max(20).describe("Stripe's tax ID type, e.g. eu_vat, gb_vat, us_ein, au_abn."), value: z.string().trim().min(1).max(64) }).nullish(),
    }),
    idempotent: true,
    openWorld: true,
    async run(context, input) {
      requireBilling();
      if (!stripe()) throw new ApiError(400, "unavailable", "Invoice details can't be set from here on this deployment. The person can add them on Stripe Checkout or in the billing portal.");
      const row = await resolveAdminAccount(context, input.account);
      const details = InvoiceDetails.safeParse({ name: input.name, address: input.address, taxId: input.tax_id ?? null });
      if (!details.success) throw new ApiError(422, "invalid_details", "Check the details: a name and an address are needed, and the tax ID type must be one used in that country.");
      const record = (outcome: string) =>
        track("invoice_details_saved", { userId: context.principal.userId, orgId: row.org.id, props: { has_tax_id: !!details.data.taxId, country: details.data.address.country, outcome, via: context.surface } });
      try {
        await applyInvoiceDetails(row.org, details.data);
      } catch (error) {
        if (error instanceof StripeError && error.code === "tax_id_invalid") {
          await record("tax_id_invalid");
          throw new ApiError(422, "tax_id_invalid", "That tax ID doesn't look right for the country. Check it, or leave it out.");
        }
        await record("error");
        return billingFailure("invoice_details", row.org.id, error);
      }
      await record("ok");
      return { saved: true };
    },
  }),
];

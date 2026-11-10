/**
 * Free credits from `/claim`, as the pages describe them. Pure, so client
 * components can use it; claiming itself is in `server/free-credits.ts`.
 */
import { creditsWorth, FREE_CREDITS } from "@sandchest/billing/plans";
import { usd } from "./format";

/** What a claim gives, as people read it: "$20". */
export const FREE_MONEY = usd(creditsWorth(FREE_CREDITS.credits));

/** The cookie that says the person came to claim, so it survives signing in and installing on GitHub. */
export const CLAIM_COOKIE = "sandchest_claim";
/** How long the intent to claim lasts, in seconds. */
export const CLAIM_COOKIE_MAX_AGE = 7 * 24 * 3_600;

/** Why an account can't claim. */
export type ClaimClosed =
  /** This person claimed already, for the account `login` names. */
  | { reason: "claimed_elsewhere"; login: string | null }
  /** Someone else claimed for this account. */
  | { reason: "org_claimed" }
  /** The account has, or has had, a plan. */
  | { reason: "has_plan" }
  /** Every claim has been made. */
  | { reason: "exhausted" };

export type ClaimOffer = { open: true; credits: number } | ({ open: false } & ClaimClosed);

/** What the recruit flow knows about claiming: set only when the person came to claim. */
export interface ClaimIntent {
  credits: number;
  /** Per account the person administers, by org id. */
  offers: Record<string, ClaimOffer>;
}

/** Why an account can't claim, in words for the person. */
export function claimClosed(closed: ClaimClosed, org: string): string {
  switch (closed.reason) {
    case "claimed_elsewhere":
      return closed.login && closed.login !== org ? `You’ve already claimed your free ${FREE_MONEY}, for ${closed.login}.` : `You’ve already claimed your free ${FREE_MONEY}.`;
    case "org_claimed":
      return `${org}’s free ${FREE_MONEY} has already been claimed.`;
    case "has_plan":
      return `${org} already has, or has had, a plan, so it can’t claim the free ${FREE_MONEY}.`;
    case "exhausted":
      return `Every free ${FREE_MONEY} has been claimed.`;
  }
}

/** The same, as the agent API says it: in credits. */
export function closedMessage(closed: ClaimClosed, org: string): string {
  switch (closed.reason) {
    case "claimed_elsewhere":
      return closed.login && closed.login !== org ? `You’ve already claimed your free credits, for ${closed.login}.` : "You’ve already claimed your free credits.";
    case "org_claimed":
      return `${org}’s free credits have already been claimed.`;
    case "has_plan":
      return `${org} already has, or has had, a plan, so it can’t claim free credits.`;
    case "exhausted":
      return "Every free credit has been claimed.";
  }
}

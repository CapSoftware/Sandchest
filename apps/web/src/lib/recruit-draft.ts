/**
 * Recruiting in progress, kept in the browser per org so a reload picks up
 * where it left off: the step, the company, the first repository, the
 * hacker and the credits. Nothing here is trusted: it's read back through
 * the same checks as anything typed, and dropped once the org has joined.
 */
import { CREDIT_AMOUNTS, DEFAULT_CREDITS } from "@sandchest/billing/plans";
import { readHacker, type HackerProfile } from "./hacker";

export const RECRUIT_STEPS = ["connect", "company", "hacker", "plan", "pay"] as const;
export type RecruitStepId = (typeof RECRUIT_STEPS)[number];

export interface RecruitDraft {
  step: RecruitStepId;
  hacker: HackerProfile;
  company: { name: string; email: string };
  firstTarget: string | null;
  credits: number;
  autoTopUp: boolean;
}

/** Long enough for any company name or email the server takes, and a handle half typed. */
const MAX_TEXT = 254;

export const draftKey = (orgId: string) => `sandchest:recruit:${orgId}`;

const text = (value: unknown, max = MAX_TEXT) => (typeof value === "string" ? value.slice(0, max) : "");

/** A stored draft, checked; undefined when there's nothing usable. `repos` are the org's repository ids. */
export function readDraft(raw: string | null, repos: readonly string[]): RecruitDraft | undefined {
  if (!raw) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const draft = value as Record<string, unknown>;
  const company = (draft.company && typeof draft.company === "object" ? draft.company : {}) as Record<string, unknown>;
  const hacker = (draft.hacker && typeof draft.hacker === "object" ? draft.hacker : {}) as Record<string, unknown>;
  return {
    step: RECRUIT_STEPS.includes(draft.step as RecruitStepId) ? (draft.step as RecruitStepId) : "connect",
    // The handle is kept as typed, even half done, so it reads back as it was left; the look is checked.
    hacker: { ...readHacker(hacker), handle: text(hacker.handle, 32) },
    company: { name: text(company.name), email: text(company.email) },
    firstTarget: typeof draft.firstTarget === "string" && repos.includes(draft.firstTarget) ? draft.firstTarget : null,
    credits: (CREDIT_AMOUNTS as readonly number[]).includes(draft.credits as number) ? (draft.credits as number) : DEFAULT_CREDITS,
    autoTopUp: typeof draft.autoTopUp === "boolean" ? draft.autoTopUp : true,
  };
}

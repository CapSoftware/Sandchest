/**
 * Facts the legal pages need. Every one is here, and nowhere else, so changing
 * them is a one-file change. A value in square brackets, or at example.com, is
 * a placeholder, and while one remains the pages stay unpublished (below).
 *
 * The model provider is never named here or anywhere in the repository; the
 * subprocessor list is sent on request.
 */
export const legal = {
  /** The company that runs the hosted service and signs the contract. */
  entity: "Cap Software, Inc.",
  /** Registered address, on one line. */
  address: "1111B Governors Ave, Dover, DE 19904, USA",
  /** Where the company is incorporated. */
  jurisdiction: "Delaware, USA",
  /** Law that governs the terms, and whose courts hear disputes. */
  governingLaw: "the laws of the State of Delaware, USA",
  courts: "the state and federal courts located in Delaware, USA",
  /** One address for general, privacy, security and legal questions. */
  email: "hello@cap.so",
  /** Shown on all three pages. Change it whenever a policy changes. */
  lastUpdated: "November 2, 2026",
} as const;

/** A value that hasn't been filled in yet. */
export function isPlaceholder(value: string): boolean {
  return value.startsWith("[") || value.includes("example.com");
}

/**
 * While any value is a placeholder the legal pages are drafts: nothing links
 * to them (footer, docs, llms.txt) and search engines are told not to index
 * them, so a deploy can't publish "[Company legal name]".
 */
export const legalDraft = Object.values(legal).some(isPlaceholder);

/** The legal pages' robots metadata: drafts with placeholders must not be indexed. */
export function legalRobots(draft = legalDraft): { robots?: { index: false; follow: false } } {
  return draft ? { robots: { index: false, follow: false } } : {};
}

const LEGAL_PATH = /^\/(terms|privacy|acceptable-use)(#|$)/;

/** Whether a link points at a legal page that is still a draft. */
export function isDraftLegalLink(href: string, draft = legalDraft): boolean {
  return draft && LEGAL_PATH.test(href);
}

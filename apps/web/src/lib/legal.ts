/**
 * Facts the legal pages need that only the company can supply. Every one is
 * here, and nowhere else, so filling them in is a one-file change. Values in
 * square brackets are placeholders: replace them before launch.
 *
 * The model provider is never named here or anywhere in the repository; the
 * subprocessor list is sent on request.
 */
export const legal = {
  /** The company that runs the hosted service and signs the contract. */
  entity: "[Company legal name]",
  /** Registered address, on one line. */
  address: "[Registered address]",
  /** Where the company is registered, e.g. "England and Wales" or "Delaware, USA". */
  jurisdiction: "[Country or state of registration]",
  /** Law that governs the terms, and whose courts hear disputes. */
  governingLaw: "[Governing law]",
  courts: "[Courts with jurisdiction]",
  /** General, privacy and security contact. One address is fine. */
  contactEmail: "[contact@example.com]",
  privacyEmail: "[privacy@example.com]",
  securityEmail: "[security@example.com]",
  /** Shown on all three pages. Change it whenever a policy changes. */
  lastUpdated: "[Date of publication]",
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

const LEGAL_PATH = /^\/(terms|privacy|acceptable-use)(#|$)/;

/** Whether a link points at a legal page that is still a draft. */
export function isDraftLegalLink(href: string, draft = legalDraft): boolean {
  return draft && LEGAL_PATH.test(href);
}

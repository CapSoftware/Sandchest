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

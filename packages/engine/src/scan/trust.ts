/**
 * Trust tier: an axis independent of severity and the skeptic's confidence,
 * answering "how much does evidence *other than one model's judgment* back this
 * finding?" It is the gate for how a finding is surfaced — ranking, and
 * (downstream) whether a PR Check may fail on it.
 *
 * The principle behind "no false positives": the model proposes, independent
 * evidence disposes. A finding backed only by the skeptic's say-so is the
 * false-positive-prone population; one corroborated by a deterministic signal
 * (the code-path proof, a dependency advisory, a literal secret) or reproduced
 * live is not. We never *drop* an unconfirmed finding — recall is untouched —
 * we rank it below corroborated ones and let the product decide what fails a
 * build and what is shown by default.
 *
 * Composing, by design: today the inputs are runtime validation, the code-path
 * proof, and deterministic-sweep origin. Taint-with-barriers and ensemble
 * agreement, when they land, slot in here as additional corroboration without
 * changing anything downstream.
 */
import { TRUST_TIERS, type Category, type Finding, type TrustTier } from "./schema";

/**
 * Categories produced by the deterministic signal sweep rather than model
 * judgement, so a finding of this class is corroborated by construction: the
 * dependency advisory (OSV, with reachability) or the literal secret at the
 * cited line stands on its own.
 */
const DETERMINISTIC_ORIGIN = new Set<Category>(["vulnerable_dependency", "hardcoded_secret"]);

/** The tier for a finding, from the evidence attached to it. */
export function trustTier(finding: Finding): TrustTier {
  if (finding.validation?.status === "verified") return "confirmed";
  if (finding.validation?.status === "path_confirmed" || DETERMINISTIC_ORIGIN.has(finding.category)) return "corroborated";
  return "unconfirmed";
}

/** Lower is stronger, for sorting. */
export function trustRank(tier: TrustTier | undefined): number {
  return tier ? TRUST_TIERS.indexOf(tier) : TRUST_TIERS.indexOf("unconfirmed");
}

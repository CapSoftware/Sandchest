/**
 * Trust tier: an axis independent of severity and the skeptic's confidence,
 * answering "how much does evidence *other than one model's judgment* back this
 * finding?" It is the gate for how a finding is surfaced — ranking, and
 * (downstream) whether a PR Check may fail on it.
 *
 * What `corroborated` actually means, measured against the Cap labelled set:
 * the finding's path is *real and reachable* (not hallucinated), or it is a
 * deterministic software-composition fact. It is NOT a claim the vulnerability
 * is exploitable — the code-path and entry-reachable proofs confirm reachability,
 * and a guard the model missed leaves a false positive reachable too (3 of 4
 * known Cap FPs were corroborated). So trust is a ranking and anti-hallucination
 * signal, not a real-vs-false classifier: it must not gate the merge-block (that
 * stays on severity + the skeptic). Only runtime `verified` — an actual
 * reproduction — is dispositive. `confirmed` (runtime) > `corroborated`
 * (reachable / deterministic) > `unconfirmed` (lone judgment or unreachable).
 * Validation never *drops* a finding; it only ranks and labels.
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

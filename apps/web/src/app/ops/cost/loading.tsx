import type { KindCost } from "@sandchest/db";
import { PageSkeleton } from "@/components/app/skeleton";
import { CostView } from "./cost-view";

const KINDS = ["pr_review", "deep", "fix_check", "recon", null] as const;

/** A row of costs for each kind and the total, as the table has once anything has run. */
const sample = (kind: KindCost["kind"]): KindCost => ({
  kind,
  scans: 120,
  measured: 118,
  inputTokens: 4_200_000,
  cachedTokens: 2_100_000,
  outputTokens: 380_000,
  modelCostUsd: 42.5,
  computeCostUsd: 3.2,
  duration: { p50: 95_000, p90: 240_000, p99: 610_000 },
  creditsCharged: 140,
  chargedModelCostUsd: 38.1,
});

/** Shown while the cost numbers load: the page's own view, of sample costs. */
export default function Loading() {
  return (
    <PageSkeleton id="ops-cost" label="Loading cost">
      <CostView range={30} byKind={KINDS.map(sample)} daily={[]} plans={[]} />
    </PageSkeleton>
  );
}

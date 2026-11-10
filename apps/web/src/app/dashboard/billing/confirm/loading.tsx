import { CREDIT_AMOUNTS } from "@sandchest/billing/plans";
import { PageSkeleton } from "@/components/app/skeleton";
import { SAMPLE_ORG_ID } from "@/lib/samples";
import { ConfirmView } from "./confirm-view";

/** A sample top-up: the largest amount offered when joining. */
const CREDITS = CREDIT_AMOUNTS.at(-1)!;

/** Shown while billing prices the change, which can take a moment: the page's own view, of a sample top-up. */
export default function Loading() {
  return (
    <PageSkeleton id="confirm" label="Pricing the change">
      <ConfirmView
        orgId={SAMPLE_ORG_ID}
        title={`Buy ${CREDITS.toLocaleString("en-US")} credits for acme`}
        preview={{ dueToday: 49, nextCycle: null }}
        help="Charged to the card on file. Bought credits never expire."
        fields={{ kind: "top_up", credits: String(CREDITS) }}
      />
    </PageSkeleton>
  );
}

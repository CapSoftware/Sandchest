import { PageSkeleton } from "@/components/app/skeleton";
import { sampleScans } from "@/lib/samples";
import { HackerRecordView } from "./hacker-view";

/** Shown the instant the hacker's link is followed: the dark stage first, then the page's own record view, of a sample hacker. */
export default function Loading() {
  return (
    <>
      <div className="hq-stage" aria-hidden="true" />
      <PageSkeleton id="hacker-record" label="Loading your hacker">
        <HackerRecordView
          login="acme"
          record={{ jobs: { deep: 3, reviews: 128, other: 9 }, lines: 412_000, found: 14, fixed: 9, open: 5, since: new Date(Date.now() - 40 * 86_400_000), active: null }}
          recent={sampleScans(6)}
          others={[]}
        />
      </PageSkeleton>
    </>
  );
}

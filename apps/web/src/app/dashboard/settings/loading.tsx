import { PageSkeleton } from "@/components/app/skeleton";
import { sampleSettings } from "@/lib/samples";
import { GeneralView } from "./settings-view";

/** Shown the instant a link is followed, until the settings arrive: the tab's own view, of a sample account. */
export default function Loading() {
  return (
    <PageSkeleton id="settings" label="Loading settings">
      <GeneralView orgs={sampleSettings().orgs} />
    </PageSkeleton>
  );
}

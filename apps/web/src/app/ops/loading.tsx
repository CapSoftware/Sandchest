import { PageSkeleton } from "@/components/app/skeleton";
import { QualityView } from "./quality-view";

/**
 * Shown while a dashboard's numbers load: the page's own view, with no numbers yet (its tables have a row per
 * kind and severity whatever the data). Only operators get this far: the layout checks first.
 */
export default function Loading() {
  return (
    <PageSkeleton id="ops-quality" label="Loading quality">
      <QualityView range={30} scans={[]} findings={[]} activity={[]} />
    </PageSkeleton>
  );
}

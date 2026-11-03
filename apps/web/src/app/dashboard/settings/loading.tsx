import { PageSkeleton } from "@/components/app/skeleton";
import { sampleSettings } from "@/lib/samples";
import { billingEnabled } from "@/server/billing";
import { config } from "@/server/config";
import { SettingsView } from "./settings-view";

/** Shown the instant a link is followed, until the settings arrive: the page's own view, of a sample account. */
export default function Loading() {
  const { orgs, billing } = sampleSettings();
  return (
    <PageSkeleton id="settings" label="Loading settings">
      <SettingsView user={{ image: null, login: "you", name: "You" }} orgs={orgs} billing={billingEnabled() ? [billing] : null} access={[]} appUrl={config().SANDCHEST_APP_URL.replace(/\/$/, "")} />
    </PageSkeleton>
  );
}

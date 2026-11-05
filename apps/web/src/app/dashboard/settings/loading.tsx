import { PageSkeleton } from "@/components/app/skeleton";
import { sampleSettings } from "@/lib/samples";
import { teamRows } from "@/lib/team";
import { billingEnabled } from "@/server/billing";
import { config } from "@/server/config";
import { SettingsView } from "./settings-view";

/** Shown the instant a link is followed, until the settings arrive: the page's own view, of a sample account. */
export default function Loading() {
  const { orgs, billing, team } = sampleSettings();
  return (
    <PageSkeleton id="settings" label="Loading settings">
      <SettingsView
        user={{ image: null, login: "you", name: "You" }}
        orgs={orgs}
        billing={billingEnabled() ? [billing] : null}
        access={[]}
        appUrl={config().SANDCHEST_APP_URL.replace(/\/$/, "")}
        teams={{ [orgs[0]!.id]: teamRows(team) }}
        memberOf={[]}
      />
    </PageSkeleton>
  );
}

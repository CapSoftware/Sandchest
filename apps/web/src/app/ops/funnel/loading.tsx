import { PageSkeleton } from "@/components/app/skeleton";
import { config } from "@/server/config";
import { FunnelView } from "./funnel-view";

/** Shown while the funnel loads: the page's own view, of sample numbers. */
export default function Loading() {
  // Billing is on when Autumn is configured, as the page decides.
  const billing = Boolean(config().AUTUMN_SECRET_KEY);
  return (
    <PageSkeleton id="ops-funnel" label="Loading funnel">
      <FunnelView
        range={30}
        billing={billing}
        funnel={{ signedUp: 120, installed: 80, plan: billing ? 40 : null, recon: 38, dig: 25, active30: 30, active7: 18 }}
        activity={{ people: 60, people7: 20, people30: 45, orgs: 50, paying: 30, orgs7: 22, orgs30: 40 }}
        daily={[]}
      />
    </PageSkeleton>
  );
}

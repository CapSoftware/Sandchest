import { RecruitSkeleton } from "@/components/recruit/recruit";
import { billingEnabled, stripePublishableKey } from "@/server/billing";
import { config } from "@/server/config";
import "../../rig.css";

/**
 * Recruiting takes the whole screen, so its loading state does too: the dark room and the page's own header and
 * panel at once, with the step that opens measured into a skeleton.
 */
export default function Loading() {
  return <RecruitSkeleton billing={billingEnabled()} payOnPage={!!stripePublishableKey()} install={!!config().GITHUB_APP_SLUG} />;
}

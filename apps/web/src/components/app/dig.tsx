import type { DashboardRepo } from "@sandchest/db";
import { DEEP_SCAN_TIERS } from "@sandchest/billing";
import { digState } from "@/lib/dig-state";
import { plural } from "@/lib/format";
import type { OrgPlan } from "@/server/org-plans";
import { DigButton } from "./dig-button";
import { HoverLink } from "./hover-link";

/** What an unsized repo holds for a Dig: the top tier. */
const MAX_DEEP_SCAN_CREDITS = DEEP_SCAN_TIERS.at(-1)!.credits;

/**
 * A repo's deep scan control: the key with its price, or why there is none.
 * A repo can be scanned again as soon as the last scan ends; each one is paid
 * for with credits, and the price is confirmed before it starts.
 */
export function Dig({ repo, plan }: { repo: DashboardRepo; plan: OrgPlan }) {
  const state = digState(repo);
  const label = repo.lastDeepScanAt ? "Scan again" : "Deep scan";
  switch (state.state) {
    case "running":
      return (
        <div className="repo-dig">
          <HoverLink href={`/dashboard/scans/${state.scanId}`} className="digging">
            <span className="blink" aria-hidden="true" />
            Scanning now
          </HoverLink>
        </div>
      );
    case "too_large":
      return (
        <div className="repo-dig">
          <span className="repo-dig-note">Over a million lines: get in touch to scan it.</span>
        </div>
      );
    case "ready": {
      if (plan && !plan.planId)
        return (
          <div className="repo-dig">
            <span className="repo-dig-note">Needs a plan</span>
          </div>
        );
      // Billing off: nothing to price.
      if (!plan) return <DigButton repoId={repo.id} label={label} note="Whole repository" />;
      // An unsized repo holds the top tier and is charged what it measures.
      const cost = state.credits ?? MAX_DEEP_SCAN_CREDITS;
      if (plan.credits < cost)
        return (
          <div className="repo-dig">
            <HoverLink href="/dashboard/settings/billing" className="repo-dig-note">
              {state.credits === undefined ? `Needs ${MAX_DEEP_SCAN_CREDITS} credits until sized: top up` : `Needs ${plural(cost, "credit")}: top up`}
            </HoverLink>
          </div>
        );
      const upTo = state.credits === undefined;
      const note = `${upTo ? "Up to " : ""}${cost} of your ${plural(plan.credits, "credit")}`;
      return <DigButton repoId={repo.id} label={label} note={note} confirm={`Scan for ${upTo ? "up to " : ""}${plural(cost, "credit")}`} />;
    }
  }
}

import { SkeletonBox } from "skullet/react";
import "../../rig.css";

/**
 * Recruiting takes the whole screen, so its loading state does too: the dark
 * room drawn at once, with the panel's placeholders where the controls go.
 */
export default function Loading() {
  return (
    <div className="onboard" aria-busy="true">
      <header className="onboard-top">
        <img src="/sandchest-logo-dark.svg" alt="" width={120} height={22} />
      </header>
      <div className="onboard-hud">
        <div className="onboard-panel">
          <div className="onboard-body">
            <span className="sr-only" role="status">
              Loading
            </span>
            <SkeletonBox width="70%" height="3.25rem" />
            <SkeletonBox width="100%" height="1rem" style={{ marginTop: "1.25rem" }} />
            <SkeletonBox width="85%" height="1rem" style={{ marginTop: "0.5rem" }} />
            <SkeletonBox width="100%" height="3.5rem" style={{ marginTop: "2rem" }} />
            <SkeletonBox width="100%" height="3.5rem" style={{ marginTop: "0.5rem" }} />
          </div>
          <div className="onboard-foot">
            <SkeletonBox width="100%" height="3.25rem" />
          </div>
        </div>
      </div>
    </div>
  );
}

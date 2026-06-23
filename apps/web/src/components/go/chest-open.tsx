"use client";

import { ChestGas } from "./chest-gas";

/* ----------------------------------------------------------------------------
   Chest open — the chest reveal frozen at its FINAL state: lid swung open, the
   warm cavity glowing, the loot beam pouring up, and the live WebGPU gas
   leaking out. No scroll, no timeline — just the payoff, looping forever. Used
   as the hero visual inside the waitlist dialog.
---------------------------------------------------------------------------- */

const ICON_FLAT = "/sandchest-icon-flat.svg";
const SEAM = 54; // lid/body seam, matching chest-reveal
const LID_OPEN = 70; // degrees the lid is held open

// Gas canvas padding (CSS px) past its host band — headroom above for the plume
// to rise and dissipate. Stable module ref so the GPU effect doesn't re-init.
const GAS_PAD = { top: 168, right: 64, bottom: 14, left: 64 };

export function ChestOpen({
  reduce = false,
  className = "",
}: {
  reduce?: boolean;
  className?: string;
}) {
  return (
    <div
      aria-hidden
      className={`relative ${className}`}
      style={{ aspectRatio: "561 / 473", containerType: "inline-size" }}
    >
      {/* idle bob so the open chest feels alive */}
      <div className="chest-bob absolute inset-0">
        {/* perspective stage — gives the open lid real 3D depth */}
        <div
          className="absolute inset-0"
          style={{ perspective: "380cqi", perspectiveOrigin: "50% 42%" }}
        >
          {/* warm halo around the whole icon */}
          <div
            className="pointer-events-none absolute inset-[-12%] z-[1]"
            style={{
              background:
                "radial-gradient(closest-side at 50% 52%, rgba(245,165,36,0.5), rgba(245,133,63,0.16) 52%, transparent 74%)",
            }}
          />

          {/* the open interior — a cavity brimming with golden treasure-light */}
          <div
            className="absolute left-[27%] right-[27%] z-[2] overflow-hidden"
            style={{
              top: `${SEAM - 26}%`,
              height: "32%",
              borderRadius: "8px 8px 6px 6px",
              background:
                "linear-gradient(180deg, #130d06 0%, #3a280f 30%, rgba(184,114,34,0.72) 56%, rgba(255,198,96,0.94) 86%, rgba(255,214,124,0.99) 100%)",
              boxShadow: "inset 0 7px 13px rgba(0,0,0,0.42)",
            }}
          >
            <div
              className="absolute inset-0"
              style={{
                background:
                  "radial-gradient(72% 80% at 50% 100%, rgba(255,222,132,0.95) 0%, rgba(250,178,60,0.42) 44%, transparent 78%)",
              }}
            />
          </div>

          {/* soft bloom at the mouth */}
          <div
            className="pointer-events-none absolute left-1/2 z-[3] aspect-square w-[58%]"
            style={{
              top: `${SEAM}%`,
              transform: "translate(-50%, -58%)",
              background:
                "radial-gradient(circle at center, rgba(253,211,99,0.72), rgba(245,165,36,0.34) 32%, transparent 66%)",
            }}
          />

          {/* loot beam — the Fortnite shaft of light out of the open mouth */}
          <div
            className="pointer-events-none absolute left-1/2 z-[4]"
            style={{
              top: `${SEAM}%`,
              width: "30%",
              height: "150%",
              transform: "translate(-50%, -100%)",
              transformOrigin: "50% 100%",
              background:
                "linear-gradient(to top, rgba(255,206,96,0.62) 0%, rgba(245,165,36,0.32) 30%, rgba(254,194,66,0.12) 62%, transparent 100%)",
              borderRadius: "999px 999px 46% 46% / 64% 64% 36% 36%",
              filter: "blur(11px)",
              mixBlendMode: "screen",
            }}
          />

          {/* the live gas, pouring up out of the open mouth */}
          <div
            className="pointer-events-none absolute inset-x-[15%] z-[8]"
            style={{ top: `${SEAM}%`, bottom: "20%" }}
          >
            <ChestGas open reduce={reduce} pad={GAS_PAD} rest={1} />
          </div>

          {/* lid — held open on its rear hinge in perspective */}
          <div
            className="absolute inset-0 z-[5] bg-contain bg-center bg-no-repeat"
            style={{
              backgroundImage: `url(${ICON_FLAT})`,
              clipPath: `inset(0 0 ${100 - SEAM - 0.6}% 0)`,
              transformOrigin: "50% 51% -20cqi",
              transform: `rotateX(${LID_OPEN}deg)`,
            }}
          />

          {/* body — the fixed front wall, top-most */}
          <div
            className="absolute inset-0 z-[7] bg-contain bg-center bg-no-repeat"
            style={{
              backgroundImage: `url(${ICON_FLAT})`,
              clipPath: `inset(${SEAM}% 0 0 0)`,
            }}
          />
        </div>
      </div>
    </div>
  );
}

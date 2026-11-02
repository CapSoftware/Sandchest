"use client";
import dynamic from "next/dynamic";
import { useCallback, useState } from "react";
import { RIG_STILL_MASTERS, type StillKind } from "@/components/rig/assets";
import { demoPainter } from "@/components/rig/paint-demo";
import { recruitPainter } from "@/components/rig/paint-recruit";
import type { Painter } from "@/components/rig/screen";
import { newSignals } from "@/components/rig/signals";
import { DEFAULT_HACKER } from "@/lib/hacker";

const RigScene = dynamic(() => import("@/components/rig/rig-scene"), { ssr: false });

/**
 * Development only: renders one still's master (see components/rig/still.ts)
 * and saves it to the temp directory through ./frame. The scene is drawn
 * centred and wide enough for the master, at the tier's pixel ratio (the
 * high tier's 1.5 needs a screen of at least that), then cropped to it.
 * Convert the PNG to public/rig/still-<kind>-<tier>.webp with
 * `cwebp -q 85 -sharp_yuv -m 6 -metadata none` (about 3% of dither cells
 * then land one level off the scene's; lossless is exact but ~20× bigger).
 */
export function StillMaster({ kind, tier }: { kind: StillKind; tier: "high" | "low" }) {
  const spec = RIG_STILL_MASTERS[kind];
  const master = spec[tier];
  const dpr = tier === "high" ? 1.5 : 1;
  // Centred on the camera's axis, as wide as the master's wider side of it, both ways.
  const full = 2 * Math.max(master.axis, master.width - master.axis);
  const [signals] = useState(() => ({ current: newSignals() }));
  const [paint] = useState<{ current: Painter | null }>(() => ({
    current:
      kind === "landing"
        ? demoPainter(DEFAULT_HACKER, signals)
        : recruitPainter({
            current: { step: "connect", profile: DEFAULT_HACKER, viewer: "octocat", accounts: ["acme"], repos: [], target: null, org: "acme", credits: 10, autoTopUp: true, currentPlan: null, billing: true },
          }),
  }));
  const [saved, setSaved] = useState<string | null>(null);

  const onReady = useCallback(() => {
    // A few more frames, so nothing is still settling, then one capture at the held moment.
    setTimeout(async () => {
      const rig = (window as unknown as { __rig?: { capture: () => string } }).__rig;
      if (!rig) return setSaved("no capture hook (development only)");
      const image = new Image();
      image.src = rig.capture();
      await image.decode();
      if (image.height !== master.height || image.width !== full) return setSaved(`drew ${image.width}×${image.height}, wanted ${full}×${master.height}: needs a screen with a pixel ratio of at least ${dpr}`);
      const crop = document.createElement("canvas");
      crop.width = master.width;
      crop.height = master.height;
      const context = crop.getContext("2d", { willReadFrequently: true })!;
      context.drawImage(image, full / 2 - master.axis, 0, master.width, master.height, 0, 0, master.width, master.height);

      const response = await fetch(`/dev/rig/frame?name=still-${kind}-${tier}`, { method: "POST", body: crop.toDataURL("image/png") });
      setSaved(((await response.json()) as { path: string }).path);
    }, 500);
  }, [kind, tier, master, full, dpr]);

  return (
    <div style={{ background: "#000", minHeight: "100vh" }}>
      <p id="master-status" style={{ position: "fixed", top: 8, left: 8, zIndex: 1, color: "#fff", font: "12px monospace" }}>
        {saved ?? "rendering…"}
      </p>
      <div style={{ position: "absolute", top: 0, left: 0, width: full / dpr, height: master.height / dpr }}>
        <RigScene profile={DEFAULT_HACKER} org="acme" shot="preview" paint={paint} signals={signals} tier={tier} light={spec.light} master onReady={onReady} />
      </div>
    </div>
  );
}

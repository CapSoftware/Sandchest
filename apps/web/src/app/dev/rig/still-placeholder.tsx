"use client";
import { useEffect, useRef, useState } from "react";
import { RIG_LANDING_PLACEHOLDER } from "@/components/rig/assets";
import { stillSpec } from "@/components/rig/rig-view";
import { drawStill } from "@/components/rig/still";

/**
 * Development only: draws the landing's still (see components/rig/still.ts)
 * at each of the band's placeholder sizes, at the low tier's pixel ratio of
 * 1 (open with `&rig-tier=low`), and saves the PNGs to the temp directory
 * through ./frame. Convert them to public/rig/placeholder-landing-<shape>.webp
 * with `cwebp -lossless -z 9 -metadata none` (lossy blurs the dither: at
 * -q 90 the wide one only drops from about 93 to 69 KB).
 */
export function StillPlaceholder() {
  const [forced, setForced] = useState(true);
  useEffect(() => setForced(new URLSearchParams(location.search).get("rig-tier") === "low"), []);
  return (
    <div style={{ background: "#000", minHeight: "100vh", padding: 8, color: "#fff", font: "12px monospace" }}>
      {!forced && <p>Open with &amp;rig-tier=low, so the still is drawn at a pixel ratio of 1.</p>}
      {(["wide", "narrow"] as const).map((shape) => (
        <Placeholder key={shape} shape={shape} />
      ))}
    </div>
  );
}

function Placeholder({ shape }: { shape: keyof typeof RIG_LANDING_PLACEHOLDER }) {
  const { width, height } = RIG_LANDING_PLACEHOLDER[shape];
  const canvas = useRef<HTMLCanvasElement>(null);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    const node = canvas.current;
    if (!node) return;
    drawStill(node);
    const poll = setInterval(async () => {
      if (node.dataset.drawn === "pending") return;
      clearInterval(poll);
      if (node.dataset.drawn !== "1") return setSaved("the still wasn't drawn");
      if (node.width !== width || node.height !== height) return setSaved(`drew ${node.width}×${node.height}, wanted ${width}×${height}`);
      const response = await fetch(`/dev/rig/frame?name=placeholder-landing-${shape}`, { method: "POST", body: node.toDataURL("image/png") });
      setSaved(((await response.json()) as { path: string }).path);
    }, 100);
    return () => clearInterval(poll);
  }, [shape, width, height]);

  return (
    <div style={{ marginBottom: 16 }}>
      <p className={`placeholder-status-${shape}`}>
        {shape}: {saved ?? "drawing…"}
      </p>
      <div style={{ position: "relative", width, height }}>
        <canvas ref={canvas} data-still={JSON.stringify(stillSpec("landing"))} style={{ width: "100%", height: "100%" }} />
      </div>
    </div>
  );
}

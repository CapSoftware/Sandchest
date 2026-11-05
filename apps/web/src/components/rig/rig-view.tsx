"use client";
import dynamic from "next/dynamic";
import { preload } from "react-dom";
import { RIG_BITMAP_URLS, RIG_IMAGE_URLS, RIG_MODEL_URL, RIG_STILL_MASTERS, type StillKind } from "./assets";
import { drawStill, STILL_SCRIPT, VIGNETTE, type StillSpec } from "./still";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RigSceneProps, Tier } from "./rig-scene";
import "./rig-view.css";

/** three.js and the scene load only where a rig is shown, and only on machines that can draw it. */
const RigScene = dynamic(() => import("./rig-scene"), { ssr: false });

/**
 * How much this machine can draw. `off` for no WebGL 2 or software
 * rendering (the still image stands in); `low` for small or busy machines,
 * phones and tablets; `high` for the rest. Stepped down at runtime if the
 * frame rate says otherwise.
 */
function pickTier(): Tier | "off" {
  // For checking a tier by hand (and for support): ?rig-tier=high, low or off.
  const forced = new URLSearchParams(location.search).get("rig-tier");
  if (forced === "high" || forced === "low" || forced === "off") return forced;
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2", { failIfMajorPerformanceCaveat: true });
    if (!gl) return "off";
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "";
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    if (/swiftshader|llvmpipe|softpipe|software|basic render/i.test(renderer)) return "off";
    const memory = (navigator as { deviceMemory?: number }).deviceMemory ?? 8;
    const cores = navigator.hardwareConcurrency ?? 4;
    const touch = matchMedia("(pointer: coarse)").matches;
    const saveData = (navigator as { connection?: { saveData?: boolean } }).connection?.saveData === true;
    if (memory <= 4 || cores <= 4 || touch || saveData) return "low";
    return "high";
  } catch {
    return "off";
  }
}

type Props = Omit<RigSceneProps, "active" | "still" | "onReady" | "onSlow" | "tier" | "master"> & {
  className?: string;
  /**
   * When the machine can't draw the scene, show a still of the room instead
   * (public/rig/poster-<room>.webp), dimmed to the scene's light. It isn't
   * shown while the scene loads: it is an older, undithered, fully lit render
   * from another angle, so the room comes up out of black instead.
   */
  poster?: boolean;
  /**
   * A still matching the scene's first frame pixel for pixel (still.ts),
   * drawn as the HTML arrives and replaced by the scene without a visible
   * change. Only for the default hacker, at the light and framing it was
   * rendered for.
   */
  opening?: StillKind;
};

/** The still for one view, with the dither and vignette the scene draws with. */
export const stillSpec = (kind: StillKind): StillSpec => ({ ...RIG_STILL_MASTERS[kind], levels: 12, floor: 0.06, vignette: VIGNETTE });

/** How long the picture takes to dip to black, and to come back, when the room changes. */
const CUT_MS = 170;

/**
 * Where a rig is drawn. The room fades up out of black when the scene's
 * first frame is ready, or a still stands in where it can't be drawn. Stops drawing while scrolled away,
 * holds still for people who prefer reduced motion, and drops a tier (then
 * to the still) if the machine can't keep up. A new room arrives behind a
 * quick dip to black, like a cut, rather than popping in.
 */
export function RigView({ className, poster, opening, profile, ...props }: Props) {
  // Fetch the model and textures alongside the page's scripts (as <link rel=preload> in the server's HTML),
  // not after three.js has loaded and the scene has mounted. The options match how three.js requests them.
  preload(RIG_MODEL_URL, { as: "fetch", crossOrigin: "anonymous" });
  for (const url of RIG_IMAGE_URLS) preload(url, { as: "image", crossOrigin: "anonymous" });
  for (const url of RIG_BITMAP_URLS) preload(url, { as: "fetch", crossOrigin: "anonymous" });
  // The still's master first of all, from the HTML's head, so it's in before the inline script asks for it.
  // The high tier's, where its media query matches: most screens that open on the still.
  if (opening) {
    const master = RIG_STILL_MASTERS[opening];
    preload(master.high.src, { as: "image", fetchPriority: "high", media: "media" in master ? master.media : undefined });
  }
  const box = useRef<HTMLDivElement>(null);
  const [tier, setTier] = useState<Tier | "off" | null>(null);
  const [visible, setVisible] = useState(true);
  const [ready, setReady] = useState(false);
  const [still, setStill] = useState(false);
  const [room, setRoom] = useState(profile.room);
  const [cut, setCut] = useState(false);
  const stillRef = useRef<HTMLCanvasElement>(null);
  const spec = opening ? stillSpec(opening) : null;

  // From the server's HTML, the inline script has already drawn it; when mounted later, draw it now.
  useLayoutEffect(() => {
    if (stillRef.current) drawStill(stillRef.current);
  }, []);

  useEffect(() => {
    setTier(pickTier());
    const query = matchMedia("(prefers-reduced-motion: reduce)");
    setStill(query.matches);
    const change = () => setStill(query.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);

  useEffect(() => {
    const node = box.current;
    if (!node) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(!!entry?.isIntersecting), { rootMargin: "120px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // Dip to black, change the room while nothing shows, then come back up.
  useEffect(() => {
    if (profile.room === room) return;
    if (still) return setRoom(profile.room);
    setCut(true);
    const swap = setTimeout(() => setRoom(profile.room), CUT_MS);
    return () => clearTimeout(swap);
  }, [profile.room, room, still]);
  useEffect(() => {
    if (!cut || profile.room !== room) return;
    // A couple of frames for the new room to draw before the lights come up.
    const lift = setTimeout(() => setCut(false), 60);
    return () => clearTimeout(lift);
  }, [cut, profile.room, room]);

  const onReady = useCallback(() => setReady(true), []);
  const onSlow = useCallback(() => {
    if (new URLSearchParams(location.search).has("rig-tier")) return;
    setReady(false);
    setTier((current) => (current === "high" ? "low" : "off"));
  }, []);

  const shown = room === profile.room ? profile : { ...profile, room };
  return (
    <div ref={box} className={`rig ${className ?? ""}`} data-ready={ready || undefined} aria-hidden="true">
      {spec && (
        <>
          {/* The inline script sizes and draws the canvas before React arrives, and the server's and the
              browser's builds of the script differ in their text: neither is React's to reconcile. */}
          <canvas
            ref={stillRef}
            suppressHydrationWarning
            className="rig-still"
            data-still={JSON.stringify(spec)}
            // Where the scene can't be drawn the still stays: keep it roughly as lit as the room should be.
            style={tier === "off" && props.light !== undefined && props.light !== spec.light ? { filter: `brightness(${props.light / spec.light})` } : undefined}
          />
          <script suppressHydrationWarning dangerouslySetInnerHTML={{ __html: STILL_SCRIPT }} />
        </>
      )}
      {poster && tier === "off" && (
        <img
          className="rig-poster"
          src={`/rig/poster-${room}.webp`}
          alt=""
          decoding="async"
          fetchPriority="high"
          style={{
            transform: props.frameShift ? `translateX(${props.frameShift * 100}%)` : undefined,
            filter: props.light !== undefined && props.light < 1 ? `brightness(${props.light})` : undefined,
          }}
          onError={(event) => (event.currentTarget.hidden = true)}
        />
      )}
      {tier && tier !== "off" && <RigScene {...props} profile={shown} tier={tier} still={still} active={visible} onReady={onReady} onSlow={onSlow} />}
      <div className="rig-cut" data-on={cut || undefined} style={{ transitionDuration: `${CUT_MS}ms` }} />
    </div>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import {
  backOut,
  easeInOut,
  motion,
  useMotionValueEvent,
  useScroll,
  useTransform,
  type MotionValue,
} from "motion/react";
import { lineup } from "@/lib/data";
import { useReducedMotionSafe } from "@/lib/use-reduced-motion-safe";
import { ChestGas } from "./chest-gas";

/* ----------------------------------------------------------------------------
   Chest reveal — the one cinematic moment on the page.

   The real Sandchest icon, unchanged. As you scroll, the lid (the top of the
   icon) swings open on a hinge — tilting back in 3D perspective like a real
   treasure chest — a dark interior is revealed, light pours out, and the loot
   (the models) rises up from inside. Scroll back up and the lid swings shut,
   back to the exact logo.

   We render the icon twice and cut it with complementary clip-paths at the seam
   (just under the lock): a "lid" half (top) and a "body" half (bottom). Closed,
   the two halves sit exactly on top of each other and reconstitute the icon
   pixel-for-pixel.

   The lid is the ONLY piece transformed in 3D: a rotateX about a hinge set back
   in Z (the rear seam), projected by a `perspective` on the stage. Everything
   else (interior, glow, embers, loot, body) is a flat layer ordered by z-index —
   loot sits above the lid (so the risen models read as out in front of the open
   lid) but below the body wall (so they emerge from within, not float on top).
   The perspective + hinge depth are expressed in `cqi` units against the scene
   container, so the 3D scales with the responsive chest size without any JS.
---------------------------------------------------------------------------- */

const ICON_FLAT = "/sandchest-icon-flat.svg"; // icon with the baked glow removed
// the lid/body seam, as a % down the icon — just below the lock, so the whole
// lock + gold band lift with the lid and nothing is cut through
const SEAM = 54;

// padding (CSS px) the chest's WebGPU gas canvas extends past its host band at
// the lid seam — a tall `top` gives the plume headroom to rise and fully
// dissipate, wide sides give the column room to widen and feather before the
// canvas edge. Stable module ref so the GPU effect doesn't re-init (see ChestGas).
const CHEST_GAS_PAD = { top: 300, right: 104, bottom: 16, left: 104 };

/* Sync a scroll-driven MotionValue to an element's opacity by hand. Motion
   (v12 + React 19) applies transform MotionValues while idle, but drops opacity
   ones the moment scrolling stops — which made the reveal vanish when you
   paused. Writing opacity straight to the node keeps it put, and it still scrubs
   both ways with scroll. */
function useOpacity(mv: MotionValue<number>) {
  const ref = useRef<HTMLDivElement>(null);
  useMotionValueEvent(mv, "change", (v) => {
    if (ref.current) ref.current.style.opacity = String(v);
  });
  useEffect(() => {
    if (ref.current) ref.current.style.opacity = String(mv.get());
  });
  return ref;
}

export function ChestReveal() {
  const reduce = useReducedMotionSafe();
  if (reduce) return <ChestRevealStatic />;
  return <ChestRevealScrolly />;
}

function ChestRevealScrolly() {
  const trackRef = useRef<HTMLDivElement>(null);

  // main scrub — runs across the whole pinned range (the open + loot reveal)
  const { scrollYProgress } = useScroll({
    target: trackRef,
    offset: ["start start", "end end"],
  });
  // entrance scrub — runs as the section rises into view, BEFORE it pins, so the
  // chest is already on screen and moving as you scroll toward it (appears
  // sooner) rather than waiting to snap in once pinned. 0 = section's top at the
  // viewport bottom, 1 = section pinned.
  const { scrollYProgress: enter } = useScroll({
    target: trackRef,
    offset: ["start end", "start start"],
  });

  // the chest's gold fog erupts once the lid is meaningfully open and settles
  // back as you scroll up — the same idea as the key button's hover glow
  const [open, setOpen] = useState(false);
  useMotionValueEvent(scrollYProgress, "change", (v) => setOpen(v > 0.32));

  // Playful entrance: the chest floats UP into place with a springy overshoot
  // (backOut) as the section enters, pops to full size, then keeps drifting
  // gently upward through the pin so it always feels buoyant and scroll-reactive
  // rather than nailed to the centre. entranceY + driftY are summed so the two
  // phases (rise-in, then float) hand off seamlessly.
  const entranceY = useTransform(enter, [0, 1], [120, 0], { ease: backOut });
  const driftY = useTransform(scrollYProgress, [0, 1], [0, -24]);
  const chestY = useTransform(() => entranceY.get() + driftY.get());
  const chestScale = useTransform(enter, [0.12, 1], [0.72, 1], { ease: backOut });

  // the lid swings open on its hinge: a 3D rotateX about the rear seam, so the
  // front lip lifts and the lid tilts back in perspective like a real chest lid.
  // (the only piece transformed in 3D — everything else is flat, z-index layered)
  const lidRotate = useTransform(scrollYProgress, [0.16, 0.64], [0, 74], {
    ease: easeInOut,
  });

  const bgGlow = useTransform(scrollYProgress, [0.18, 0.56], [0, 1]);
  const bgGlowScale = useTransform(scrollYProgress, [0.18, 0.82], [0.7, 1.05]);
  const mouthGlow = useTransform(scrollYProgress, [0.22, 0.56], [0, 1]);
  const mouthGlowScale = useTransform(scrollYProgress, [0.22, 0.64], [0.4, 1]);

  // the Fortnite "loot beam" — a soft column of light that grows up out of the
  // open mouth once the lid lifts. Eased so it unfurls gracefully, not abruptly.
  const beamGlow = useTransform(scrollYProgress, [0.26, 0.62], [0, 1]);
  const beamScaleY = useTransform(scrollYProgress, [0.26, 0.72], [0.32, 1], {
    ease: easeInOut,
  });

  // headline rides the entrance too, so it's already there and lifting into
  // place as you scroll in, then springs to rest
  const headlineOpacity = useTransform(enter, [0.25, 0.8], [0, 1]);
  const headlineY = useTransform(enter, [0.25, 1], [30, 0], { ease: backOut });

  // opacity applied manually (see useOpacity) so the reveal holds when idle
  const bgRef = useOpacity(bgGlow);
  const mouthRef = useOpacity(mouthGlow);
  const beamRef = useOpacity(beamGlow);
  const headRef = useOpacity(headlineOpacity);

  return (
    <section
      ref={trackRef}
      id="chest"
      aria-label="What's in the chest"
      // full-bleed out of the centred page column so the glow fades into the
      // page edges instead of being clipped by the gutter
      className="relative h-[360vh]"
      style={{ width: "100vw", marginInline: "calc(50% - 50vw)" }}
    >
      <div className="sticky top-0 flex h-screen flex-col items-center justify-center overflow-hidden">
        {/* big warm wash — fades to transparent well before the viewport edges */}
        <motion.div
          ref={bgRef}
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-0"
          style={{
            scale: bgGlowScale,
            background:
              "radial-gradient(circle 46vw at 50% 50%, rgba(245,165,36,0.42), rgba(245,133,63,0.16) 34%, transparent 70%)",
          }}
        />

        {/* eyebrow + headline, in the same centred column as the chest so they
            stay together and leave together when the pin releases */}
        <motion.div
          ref={headRef}
          className="pointer-events-none relative z-40 mb-32 w-full max-w-[42rem] px-6 text-center opacity-0 sm:mb-24"
          style={{ y: headlineY }}
        >
          <h2 className="text-balance text-[2.25rem] font-semibold leading-[1.04] tracking-[-0.02em] text-fg md:text-5xl">
            What&rsquo;s in the{" "}
            <span className="bg-gradient-to-b from-[#FDD363] via-[#F5A524] to-[#F5853F] bg-clip-text text-transparent drop-shadow-[0_0_22px_rgba(245,165,36,0.4)]">
              chest
            </span>
            ?
          </h2>
          <p className="mx-auto mt-3 max-w-[34rem] text-sm text-fg-soft md:text-base">
            The best open coding models, all behind one open-source gateway.
            Use the right model for each coding-agent run.
          </p>
        </motion.div>

        {/* the chest scene — a container so the 3D depth scales with the
            responsive chest size (the cqi units below resolve against this box) */}
        <motion.div
          className="relative w-[clamp(18rem,56vw,30rem)]"
          style={{
            aspectRatio: "561 / 473",
            scale: chestScale,
            y: chestY,
            containerType: "inline-size",
          }}
        >
          {/* idle bob — a gentle, continuous float so the chest always feels
              buoyant and alive (the playful "loot is in here" energy), layered
              under the scroll transforms so the two compose */}
          <div className="chest-bob absolute inset-0">
          {/* perspective stage — gives the lid's rotateX real depth. Viewed from
              a touch above centre, so we see down into the open chest. */}
          <div
            className="absolute inset-0"
            style={{ perspective: "380cqi", perspectiveOrigin: "50% 42%" }}
          >
            {/* the icon's warm halo (recreated, since the flat halves drop the
                baked glow) — always on, so the rest state matches the logo */}
            <div
              aria-hidden
              className="pointer-events-none absolute inset-[-12%] z-[1]"
              style={{
                background:
                  "radial-gradient(closest-side at 50% 52%, rgba(245,165,36,0.5), rgba(245,133,63,0.16) 52%, transparent 74%)",
              }}
            />

            {/* the open chest interior — you look down into a warm cavity that
                glows from within, the way a Fortnite chest brims with light
                rather than showing a dark hole. A softly-shadowed recess, with
                golden treasure-light welling up from the floor and a gentle
                back-wall sheen (no hard glassy rims). It's always present — the
                closed lid and body wall occlude it, and the lifting lid uncovers
                it, so the glow is *revealed* by the opening, not faded in. */}
            <div aria-hidden>
              <div
                className="absolute left-[27%] right-[27%] z-[2] overflow-hidden"
                style={{
                  top: `${SEAM - 26}%`,
                  height: "32%",
                  borderRadius: "8px 8px 6px 6px",
                  // brimming with golden light: dark only in the narrow recess
                  // under the lifted lid (top), then flooding to bright gold — so
                  // it reads as a chest full of treasure-light, not an empty box
                  background:
                    "linear-gradient(180deg, #130d06 0%, #3a280f 30%, rgba(184,114,34,0.72) 56%, rgba(255,198,96,0.94) 86%, rgba(255,214,124,0.99) 100%)",
                  boxShadow: "inset 0 7px 13px rgba(0,0,0,0.42)",
                }}
              >
                {/* concentrated pool of light at the bottom — the source the
                    loot rises out of */}
                <div
                  className="absolute inset-0"
                  style={{
                    background:
                      "radial-gradient(72% 80% at 50% 100%, rgba(255,222,132,0.95) 0%, rgba(250,178,60,0.42) 44%, transparent 78%)",
                  }}
                />
              </div>
            </div>

            {/* light pouring out of the gap as the lid raises — a soft warm
                bloom at the mouth (kept gentle so it reads as glow, not a harsh
                hotspot; the beam and gas above carry the drama) */}
            <motion.div
              ref={mouthRef}
              aria-hidden
              className="pointer-events-none absolute left-1/2 z-[3] aspect-square w-[58%] opacity-0"
              style={{
                top: `${SEAM}%`,
                x: "-50%",
                y: "-58%",
                scale: mouthGlowScale,
                background:
                  "radial-gradient(circle at center, rgba(253,211,99,0.7), rgba(245,165,36,0.32) 32%, transparent 66%)",
              }}
            />

            {/* loot beam — the Fortnite shaft of light that grows up out of the
                open mouth. Sits behind the lid/loot (z-4) and above the interior,
                rising well above the chest so its top is always clear; `screen`
                blend makes it read as light, never a hard-edged shape. */}
            <motion.div
              ref={beamRef}
              aria-hidden
              className="pointer-events-none absolute left-1/2 z-[4] opacity-0"
              style={{
                top: `${SEAM}%`,
                x: "-50%",
                y: "-100%",
                width: "30%",
                height: "150%",
                scaleY: beamScaleY,
                transformOrigin: "50% 100%",
                background:
                  "linear-gradient(to top, rgba(255,206,96,0.62) 0%, rgba(245,165,36,0.32) 30%, rgba(254,194,66,0.12) 62%, transparent 100%)",
                borderRadius: "999px 999px 46% 46% / 64% 64% 36% 36%",
                filter: "blur(11px)",
                mixBlendMode: "screen",
              }}
            />

            {/* the chest's gold gas — a WebGPU volumetric smoke field welling up
                out of the lid seam (the top edge of this host band) and rising
                into the headroom above, widening and dissipating like real
                vapour. Sits in FRONT of the whole chest (z-8) so the silhouette
                never hard-clips it; the gas lives almost entirely ABOVE the seam,
                so it reads as leaking out of the crack, not pasted over the face.
                It idles as a gentle leak and floods to a full pour once open. */}
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-[15%] z-[8]"
              style={{ top: `${SEAM}%`, bottom: "20%" }}
            >
              <ChestGas open={open} reduce={false} pad={CHEST_GAS_PAD} rest={0.5} />
            </div>

            {/* lid — the only piece that moves in 3D: it swings open on its rear
                hinge, tilting back in perspective. Below the loot, so the risen
                models read as out in front of the open lid. */}
            <motion.div
              aria-hidden
              className="absolute inset-0 z-[5] bg-contain bg-center bg-no-repeat"
              style={{
                backgroundImage: `url(${ICON_FLAT})`,
                // overlap the seam by a hair so the closed state has no seam line
                clipPath: `inset(0 0 ${100 - SEAM - 0.6}% 0)`,
                transformOrigin: "50% 51% -20cqi",
                rotateX: lidRotate,
              }}
            />

            {/* the loot — the models, rising up out of the open chest. Sits
                ABOVE the gas (z-9) so the chips stay crisp and legible while the
                vapour wafts behind them, the way a Fortnite item reads clearly in
                front of its loot beam. */}
            <div
              className="absolute left-1/2 z-[9] flex w-[78%] flex-col items-center gap-3"
              style={{ top: `${SEAM}%`, transform: "translate(-50%, -112%)" }}
            >
              {lineup.map((model, i) => (
                <LootChip
                  key={model.name}
                  model={model}
                  index={i}
                  total={lineup.length}
                  progress={scrollYProgress}
                />
              ))}
            </div>

            {/* body — bottom of the icon (clipped below the seam): the fixed
                front wall. Top-most, so it occludes the foot of the rising loot. */}
            <div
              aria-hidden
              className="absolute inset-0 z-[7] bg-contain bg-center bg-no-repeat"
              style={{
                backgroundImage: `url(${ICON_FLAT})`,
                clipPath: `inset(${SEAM}% 0 0 0)`,
              }}
            />
          </div>
          </div>
        </motion.div>
      </div>
    </section>
  );
}

/* A single model "loot" chip — owns its slice of the scroll timeline so they
   rise out staggered after the lid lifts, then hold until you scroll back up. */
function LootChip({
  model,
  index,
  total,
  progress,
}: {
  model: (typeof lineup)[number];
  index: number;
  total: number;
  progress: MotionValue<number>;
}) {
  // hold on the open, lit chest for a beat, then the loot springs out of it,
  // each chip popping past its mark and settling (backOut) for a playful bounce;
  // top chip rises last
  const start = 0.5 + (total - 1 - index) * 0.06;
  const y = useTransform(progress, [start, start + 0.26], [98, 0], {
    ease: backOut,
  });
  const opacity = useTransform(progress, [start, start + 0.12], [0, 1]);
  const scale = useTransform(progress, [start, start + 0.24], [0.5, 1], {
    ease: backOut,
  });
  const ref = useOpacity(opacity);

  const live = model.status === "live";

  return (
    <motion.div
      ref={ref}
      style={{ y, scale }}
      className="flex w-full items-center gap-2.5 rounded-md border border-line-strong bg-surface px-3 py-2 opacity-0 shadow-[0_12px_34px_-12px_rgba(245,140,66,0.75)]"
    >
      <span
        aria-hidden
        className={`h-2 w-2 shrink-0 rounded-full ${
          live ? "bg-accent shadow-[0_0_10px_1px_rgba(245,133,63,0.9)]" : "bg-faint"
        }`}
      />
      <span className="text-sm font-semibold text-fg">{model.name}</span>
      <span
        className={`ml-auto rounded-[3px] border px-1.5 py-0.5 font-mono text-[0.65rem] ${
          live ? "border-accent/50 text-accent" : "border-line-strong text-muted"
        }`}
      >
        {live ? "live" : "soon"}
      </span>
    </motion.div>
  );
}

/* Reduced-motion / no-scroll fallback: the finished frame, held still. */
function ChestRevealStatic() {
  return (
    <section
      id="chest"
      aria-label="What's in the chest"
      className="gutter border-t border-line py-16 md:py-20"
    >
      <div className="relative mx-auto flex max-w-[40rem] flex-col items-center text-center">
        <h2 className="text-balance text-[2.25rem] font-semibold leading-[1.04] tracking-[-0.02em] text-fg md:text-4xl">
          What&rsquo;s in the{" "}
          <span className="bg-gradient-to-b from-[#FDD363] via-[#F5A524] to-[#F5853F] bg-clip-text text-transparent drop-shadow-[0_0_22px_rgba(245,165,36,0.4)]">
            chest
          </span>
          ?
        </h2>
        <p className="mx-auto mt-3 max-w-[34rem] text-sm text-fg-soft md:text-base">
          The best open coding models, all behind one open-source gateway. Use
          the right model for each coding-agent run.
        </p>

        <div className="mt-10 flex flex-col items-center gap-2">
          {lineup.map((model) => {
            const live = model.status === "live";
            return (
              <div
                key={model.name}
                className="flex items-center gap-2.5 rounded-md border border-line-strong bg-surface px-3 py-2"
              >
                <span
                  aria-hidden
                  className={`h-2 w-2 shrink-0 rounded-full ${live ? "bg-accent" : "bg-faint"}`}
                />
                <span className="font-mono text-sm font-semibold text-fg">{model.name}</span>
                <span
                  className={`ml-auto rounded-[3px] border px-1.5 py-0.5 font-mono text-[0.65rem] ${
                    live ? "border-accent/50 text-accent" : "border-line-strong text-muted"
                  }`}
                >
                  {live ? "live" : "soon"}
                </span>
              </div>
            );
          })}
        </div>

        <div className="relative mt-10 w-[clamp(15rem,58vw,20rem)]">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 -z-10 scale-[1.7]"
            style={{
              background:
                "radial-gradient(circle at center, rgba(245,165,36,0.35), transparent 64%)",
            }}
          />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/sandchest-icon.svg" alt="The Sandchest chest" className="w-full" />
        </div>
      </div>
    </section>
  );
}

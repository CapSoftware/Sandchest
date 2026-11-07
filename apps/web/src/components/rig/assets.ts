/**
 * The files every rig draws with, in one list, so the page can start fetching
 * them with the HTML instead of after three.js has loaded and the scene has
 * mounted. Kept free of three.js so the page can import it cheaply.
 */
export const RIG_MODEL_URL = "/rig/hacker.glb";
/** The same hacker in more detail, for their own page only: smoother (rounder fingertips) and sharper skin. */
export const RIG_MODEL_HQ_URL = "/rig/hacker-hq.glb";
/** Which texels of the body texture are the hoodie. */
export const RIG_HOODIE_MASK_URL = "/rig/hacker-hoodie.webp";
/** The photographed surfaces, as `/rig/<surface>-<map>.webp`. */
export const RIG_SURFACES = ["desk", "wall"] as const;
export const surfaceUrls = (surface: (typeof RIG_SURFACES)[number]) => (["color", "normal", "rough"] as const).map((map) => `/rig/${surface}-${map}.webp`);
/** Loaded as <img>s. */
export const RIG_IMAGE_URLS = [RIG_HOODIE_MASK_URL];
/** Fetched and decoded as ImageBitmaps (textures.ts). */
export const RIG_BITMAP_URLS = RIG_SURFACES.flatMap(surfaceUrls);

/**
 * The stills (see still.ts), one per view that opens on the default hacker,
 * rendered by `/dev/rig?view=master`. `axis` is where the camera's axis falls
 * across the master. Re-render them whenever the room, the hacker, the
 * lighting or the post-processing changes.
 */
export const RIG_STILL_MASTERS = {
  // The onboarding, on wide screens: the centred panel's dim room, the picture moved left.
  onboard: {
    light: 0.55,
    shift: -0.3,
    media: "(min-width: 861px)",
    high: { src: "/rig/still-onboard-high.webp", width: 2880, height: 1200, axis: 576 },
    low: { src: "/rig/still-onboard-low.webp", width: 1920, height: 800, axis: 384 },
  },
  // The landing page's band, fully lit and centred.
  landing: {
    light: 1,
    shift: 0,
    high: { src: "/rig/still-landing-high.webp", width: 1824, height: 912, axis: 912 },
    low: { src: "/rig/still-landing-low.webp", width: 1216, height: 608, axis: 608 },
  },
} as const;

export type StillKind = keyof typeof RIG_STILL_MASTERS;

/**
 * The landing band's placeholder: its still, already dithered, as plain
 * images in the HTML, so the room shows before any script runs or the band
 * comes near. Drawn by `/dev/rig?view=placeholder&rig-tier=low` as the low
 * tier draws it, for the band's two shapes: 2:1, and 4:3 where
 * `narrow.media` matches (the band's own breakpoint in globals.css).
 * Re-render them with the landing's masters.
 */
export const RIG_LANDING_PLACEHOLDER = {
  wide: { src: "/rig/placeholder-landing-wide.webp", width: 1216, height: 608 },
  narrow: { src: "/rig/placeholder-landing-narrow.webp", width: 400, height: 300, media: "(max-width: 48rem)" },
} as const;

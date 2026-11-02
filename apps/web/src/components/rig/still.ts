/**
 * The still that stands in for the scene until its first frame is up, drawn
 * to match that frame pixel for pixel, so the scene can take over without a
 * visible change.
 *
 * A master is rendered once by the scene itself (`/dev/rig?view=master`):
 * the default hacker at the moment the scene first shows (STILL_TIME), lit
 * as the page lights it, but before the vignette and the dither, which
 * depend on the size the picture is shown at. It is wider than any screen,
 * centred on the camera's axis. The page crops it to its own box (the scene
 * keeps the camera's vertical view and widens or narrows to fit, so any box
 * is a crop of a wider picture), then applies the vignette and the dither
 * exactly as dither.ts and the vignette do, in the same device pixels.
 *
 * `drawStill` runs as an inline script straight after its canvas in the
 * server's HTML, before any of the page's scripts have loaded, so it must
 * not use anything from outside its own body.
 */

/** The scene's vignette (postprocessing's VignetteEffect, default technique), which the still draws itself. */
export const VIGNETTE = { offset: 0.16, darkness: 0.93 } as const;

/**
 * Where the scene's clock stands on the first frame the page shows: it
 * starts at 0 when the files are in, and the page is told on the third
 * frame, at the resting 30 frames a second. Masters are rendered at this
 * moment.
 */
export const STILL_TIME = 0.1;

/** One master: its file, size in pixels, and where the camera's axis falls across it. */
export interface StillMaster {
  src: string;
  width: number;
  height: number;
  axis: number;
}

/** A still for one view of the scene, at the light and framing it was rendered for, for each tier. */
export interface StillSpec {
  light: number;
  shift: number;
  /** Shown only where this media query matches (where the page uses this light and framing). */
  media?: string;
  high: StillMaster;
  low: StillMaster;
  /** dither.ts and the vignette's settings. */
  levels: number;
  floor: number;
  vignette: { offset: number; darkness: number };
}

/** Draws the still into `canvas` (which carries its StillSpec as data-still), if this page can show it. */
export function drawStill(canvas: HTMLCanvasElement): void {
  try {
    if (canvas.dataset.drawn) return;
    const spec = JSON.parse(canvas.dataset.still || "null");
    if (!spec || (spec.media && !matchMedia(spec.media).matches)) return;
    canvas.dataset.drawn = "pending";

    // The tier the scene will pick (rig-view.tsx), without the WebGL probe: that only decides
    // whether there is a scene at all, and without one the still stays.
    const nav = navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } };
    const forced = new URLSearchParams(location.search).get("rig-tier");
    const low = forced
      ? forced === "low"
      : (nav.deviceMemory ?? 8) <= 4 || (nav.hardwareConcurrency ?? 4) <= 4 || matchMedia("(pointer: coarse)").matches || nav.connection?.saveData === true;
    const master = low ? spec.low : spec.high;
    // The scene's pixel ratio and canvas size (three.js floors them).
    const dpr = low ? 1 : Math.min(Math.max(window.devicePixelRatio || 1, 1), 1.5);
    const box = (canvas.parentElement as HTMLElement).getBoundingClientRect();
    const w = Math.floor(box.width * dpr);
    const h = Math.floor(box.height * dpr);
    if (!w || !h) return;
    // Master pixels per canvas pixel, and where the canvas's left edge falls on the master.
    const k = master.height / h;
    const left = master.axis - (0.5 + spec.shift) * w * k;
    if (left < -0.01 || left + w * k > master.width + 0.01) return;

    const image = new Image();
    image.src = master.src;
    image
      .decode()
      .then(() => {
        if (canvas.dataset.drawn !== "pending") return;
        const began = performance.now();
        canvas.width = w;
        canvas.height = h;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) return;
        context.imageSmoothingQuality = "high";
        context.drawImage(image, left, 0, w * k, master.height, 0, 0, w, h);
        const frame = context.getImageData(0, 0, w, h);
        const px = frame.data;

        // The master's values in the dither's 1/2.2 space, highlights past white unfolded (dither.ts).
        const KNEE = 0.75;
        const open = new Float32Array(256);
        for (let i = 0; i < 256; i++) {
          const v = i / 255;
          open[i] = v <= KNEE ? v : i === 255 ? 8 : KNEE - (1 - KNEE) * Math.log(1 - (v - KNEE) / (1 - KNEE));
        }
        const levels: number = spec.levels;
        const floor: number = spec.floor;
        const cell = Math.round(2 * dpr);
        const smooth = (e0: number, e1: number, x: number) => {
          const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
          return t * t * (3 - 2 * t);
        };
        // The vignette's factor, in the dither's 1/2.2 space, by squared distance from the centre (in uv).
        const VN = 65536;
        const vignette = new Float32Array(VN + 1);
        const { offset, darkness } = spec.vignette;
        for (let i = 0; i <= VN; i++) {
          const d = Math.sqrt((i / VN) * 0.5);
          vignette[i] = Math.pow(smooth(0.8, offset * 0.799, d * (darkness + offset)), 1 / 2.2);
        }
        // From a dithered level in 1/2.2 space to the 8-bit sRGB the scene writes.
        const EN = 16384;
        const encode = new Uint8ClampedArray(EN + 1);
        for (let i = 0; i <= EN; i++) {
          const linear = Math.pow(i / EN, 2.2);
          encode[i] = Math.round(255 * (linear <= 0.0031308 ? linear * 12.92 : 1.055 * Math.pow(linear, 0.41666) - 0.055));
        }
        // The 8×8 Bayer thresholds, as dither.ts computes them.
        const bayer2 = (x: number, y: number) => {
          const fx = Math.floor(x);
          const fy = Math.floor(y);
          const v = fx * 0.5 + fy * fy * 0.75;
          return v - Math.floor(v);
        };
        const bayer = new Float32Array(64);
        for (let y = 0; y < 8; y++)
          for (let x = 0; x < 8; x++)
            bayer[y * 8 + x] = (bayer2(x * 0.25, y * 0.25) * 0.0625 + bayer2(x * 0.5, y * 0.5) * 0.25 + bayer2(x, y)) * 0.984375 + 0.0078125;

        const uu = new Float32Array(w);
        const column = new Uint8Array(w);
        for (let x = 0; x < w; x++) {
          const u = (x + 0.5) / w - 0.5;
          uu[x] = u * u;
          column[x] = Math.floor((x + 0.5) / cell) % 8;
        }
        for (let y = 0; y < h; y++) {
          // gl_FragCoord counts rows from the bottom.
          const fy = h - 1 - y + 0.5;
          const v = fy / h - 0.5;
          const vv = v * v;
          const row = (Math.floor(fy / cell) % 8) * 8;
          for (let x = 0, i = y * w * 4; x < w; x++, i += 4) {
            const shade = vignette[Math.min(Math.round(((uu[x]! + vv) / 0.5) * VN), VN)]!;
            // The colour after the vignette, clamped to white, as dither.ts sees it.
            const r = Math.min(open[px[i]!]! * shade, 1);
            const g = Math.min(open[px[i + 1]!]! * shade, 1);
            const b = Math.min(open[px[i + 2]!]! * shade, 1);
            const value = Math.max(r, g, b);
            px[i + 3] = 255;
            const lifted = Math.min(Math.max((value - floor) / (1 - floor), 0), 1);
            const stepped = Math.floor(lifted * levels + bayer[row + column[x]!]!) / levels;
            if (stepped === 0 || value <= 1e-4) {
              px[i] = px[i + 1] = px[i + 2] = 0;
              continue;
            }
            // Each cell keeps its hue: the colour over its brightest channel, at the dithered level.
            const scale = (stepped / value) * EN;
            px[i] = encode[Math.round(r * scale)]!;
            px[i + 1] = encode[Math.round(g * scale)]!;
            px[i + 2] = encode[Math.round(b * scale)]!;
          }
        }
        context.putImageData(frame, 0, 0);
        canvas.dataset.drawn = "1";
        performance.measure?.("rig-still", { start: began, end: performance.now() });
      })
      .catch(() => {
        canvas.dataset.drawn = "";
      });
  } catch {
    // No still: the scene fades up from black instead.
  }
}

/** The inline script that draws the still into the canvas just before it, as the HTML arrives. */
export const STILL_SCRIPT = `(${drawStill.toString()})(document.currentScript.previousElementSibling)`;

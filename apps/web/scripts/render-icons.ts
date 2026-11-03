/**
 * Renders every favicon, app icon and profile picture from the header's pixel
 * chest, so they all match the logo:
 *
 *   favicon.ico                    16, 32 and 48, for anything that asks for /favicon.ico
 *   favicon-{16,32,48,96}.png      browser tabs and search results
 *   apple-touch-icon.png           180, iOS home screen
 *   icon-{192,512}.png             the web manifest
 *   icon-maskable-512.png          Android's adaptive icon, inside its safe circle
 *   social-avatar.png              1024, a profile picture for social and community accounts
 *
 * Small sizes use the 15 × 14 chest (`sandchest-icon-small.svg`), the rest the
 * 23 × 20 one (`sandchest-icon.svg`). Each is scaled by a whole number, so
 * every art pixel stays a sharp square. Favicons are transparent; the rest sit
 * on the page background inside the chest's dithered glow, like the hero.
 * Run after changing the art, then bump BRAND_VERSION in `src/lib/site.ts`:
 *
 *   bun run icons
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { PNG } from "pngjs";
import { bayer, LIGHT_RAMP } from "../src/lib/chest-dither";

const publicDir = join(import.meta.dirname, "..", "public");

type Rgb = readonly [number, number, number];
const BACKGROUND: Rgb = [0x0d, 0x0a, 0x07];

interface Art {
  width: number;
  height: number;
  pixels: Uint8Array;
}

/** Rasterises a pixel-grid SVG at one pixel per art pixel. */
function loadArt(file: string): Art {
  const svg = readFileSync(join(publicDir, file));
  const width = Number(/viewBox="0 0 (\d+) (\d+)"/.exec(svg.toString())?.[1]);
  const image = new Resvg(svg, { fitTo: { mode: "width", value: width }, shapeRendering: 0 }).render();
  return { width: image.width, height: image.height, pixels: image.pixels };
}

const small = loadArt("sandchest-icon-small.svg");
const large = loadArt("sandchest-icon.svg");

interface Icon {
  file: string;
  size: number;
  art: Art;
  /** Screen pixels per art pixel. */
  scale: number;
  /** Background and glow, or transparent. */
  backdrop: boolean;
}

/** The glow's reach beyond the chest, in chest widths. */
const GLOW_REACH = 0.62;
const GLOW_STRENGTH = 0.36;

function render({ size, art, scale, backdrop }: Icon): PNG {
  const png = new PNG({ width: size, height: size });
  const w = art.width * scale;
  const h = art.height * scale;
  const left = Math.floor((size - w) / 2);
  const top = Math.floor((size - h) / 2);
  // The glow is dithered on a grid half the art pixel, like the hero's halo.
  const dot = Math.max(1, Math.round(scale / 2));
  const cx = size / 2;
  const cy = size / 2;
  const rx = (w / 2) * (1 + GLOW_REACH);
  const ry = (h / 2) * (1 + GLOW_REACH * 1.15);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4;
      const ax = Math.floor((x - left) / scale);
      const ay = Math.floor((y - top) / scale);
      if (x >= left && y >= top && ax < art.width && ay < art.height) {
        const a = (ay * art.width + ax) * 4;
        if (art.pixels[a + 3] > 127) {
          png.data.set([art.pixels[a], art.pixels[a + 1], art.pixels[a + 2], 255], o);
          continue;
        }
      }
      if (!backdrop) {
        png.data.set([0, 0, 0, 0], o);
        continue;
      }
      // Sampled at the centre of its dot, so each dot is one solid colour.
      const gx = Math.floor(x / dot);
      const gy = Math.floor(y / dot);
      const dx = ((gx + 0.5) * dot - cx) / rx;
      const dy = ((gy + 0.5) * dot - cy) / ry;
      const level = GLOW_STRENGTH * Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy)) ** 1.6;
      const step = Math.min(LIGHT_RAMP.length - 1, Math.floor(level * (LIGHT_RAMP.length - 1) + bayer(gx, gy)));
      const colour = step === 0 ? BACKGROUND : LIGHT_RAMP[step];
      png.data.set([colour[0], colour[1], colour[2], 255], o);
    }
  }
  return png;
}

/** The largest whole scale that fits the art within `fraction` of the canvas. */
const fit = (art: Art, size: number, fraction: number) =>
  Math.max(1, Math.floor((size * fraction) / Math.max(art.width, art.height)));

/**
 * Android masks adaptive icons to as little as a circle of 40% radius around
 * the centre, so the chest's corners must stay inside it.
 */
const maskableScale = (art: Art, size: number) =>
  Math.floor((0.4 * size) / (Math.hypot(art.width, art.height) / 2));

const icons: Icon[] = [
  { file: "favicon-16x16.png", size: 16, art: small, scale: 1, backdrop: false },
  { file: "favicon-32x32.png", size: 32, art: small, scale: 2, backdrop: false },
  { file: "favicon-48x48.png", size: 48, art: large, scale: 2, backdrop: false },
  { file: "favicon-96x96.png", size: 96, art: large, scale: 4, backdrop: false },
  { file: "apple-touch-icon.png", size: 180, art: large, scale: fit(large, 180, 0.72), backdrop: true },
  { file: "icon-192.png", size: 192, art: large, scale: fit(large, 192, 0.75), backdrop: true },
  { file: "icon-512.png", size: 512, art: large, scale: fit(large, 512, 0.75), backdrop: true },
  { file: "icon-maskable-512.png", size: 512, art: large, scale: maskableScale(large, 512), backdrop: true },
  // Profile pictures are usually cropped to a circle, so the chest sits well inside it.
  { file: "social-avatar.png", size: 1024, art: large, scale: fit(large, 1024, 0.56), backdrop: true },
];

const encoded = new Map<number, Buffer>();
for (const icon of icons) {
  const png = PNG.sync.write(render(icon));
  writeFileSync(join(publicDir, icon.file), png);
  if (!icon.backdrop) encoded.set(icon.size, png);
  console.log(`Wrote ${icon.file} (${icon.size}×${icon.size}, ${icon.scale}× art)`);
}

/** An ICO holding PNG images, which every browser since IE 9 reads. */
function ico(images: [size: number, png: Buffer][]): Buffer {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(([size, png], i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(size % 256, e);
    header.writeUInt8(size % 256, e + 1);
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(png.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map(([, png]) => png)]);
}

const icoSizes = [16, 32, 48];
writeFileSync(
  join(publicDir, "favicon.ico"),
  ico(icoSizes.map((s) => [s, encoded.get(s) as Buffer])),
);
console.log(`Wrote favicon.ico (${icoSizes.join(", ")})`);

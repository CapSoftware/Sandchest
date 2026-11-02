/** Text helpers for the screen painters. Free of three.js, so pages can import them without loading it. */

/** `#rrggbb` at an alpha, for gradients. */
export function hexAlpha(hex: string, alpha: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/** How much of `text` has been typed `seconds` after it started, at `rate` characters a second. */
export function typed(text: string, seconds: number, rate = 70): string {
  if (seconds <= 0) return "";
  return text.slice(0, Math.floor(seconds * rate));
}

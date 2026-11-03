/**
 * Pixel art as text: one string per row, one character per pixel. Turned into
 * a single SVG path per colour (runs of a row merged into one rectangle), so
 * an icon is a few hundred bytes of markup and draws crisp at any size.
 */
export function pixelPath(rows: readonly string[], ink = "X"): string {
  let d = "";
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (row[x] !== ink) continue;
      let run = 1;
      while (row[x + run] === ink) run++;
      d += `M${x} ${y}h${run}v1h-${run}z`;
      x += run - 1;
    }
  });
  return d;
}

/** "#1c1a19" mixed `amount` of the way to `toward`. */
export function mixHex(from: string, toward: string, amount: number): string {
  const channel = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  const out = [0, 1, 2].map((i) => Math.round(channel(from, i) + (channel(toward, i) - channel(from, i)) * amount));
  return `#${out.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

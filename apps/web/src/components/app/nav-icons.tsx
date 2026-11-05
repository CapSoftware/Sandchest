import { pixelPath } from "@/lib/pixel-art";

/** Each section's 9-pixel icon, shown with its label in the phone's tab bar. */
const ICONS: Record<string, readonly string[]> = {
  "/dashboard": ["XXXX.XXXX", "X..X.X..X", "X..X.X..X", "XXXX.XXXX", ".........", "XXXX.XXXX", "X..X.X..X", "X..X.X..X", "XXXX.XXXX"],
  "/dashboard/scans": [".XXXX....", "X....X...", "X....X...", "X....X...", "X....X...", ".XXXXX...", ".....XX..", "......XX.", ".......XX"],
  "/dashboard/findings": ["X.......X", ".X.XXX.X.", "..XXXXX..", "XXX.X.XXX", "..XXXXX..", "XXXXXXXXX", "..XXXXX..", ".X.XXX.X.", "X.......X"],
  "/dashboard/cves": ["XXXXXXXXX", "X...X...X", "X...X...X", "X...X...X", "X.......X", ".X..X..X.", ".X.....X.", "..X...X..", "...XXX..."],
  "/dashboard/repos": [".XXXXXXX.", "X.......X", "XXXXXXXXX", "X...X...X", "X..XXX..X", "X...X...X", "X.......X", "XXXXXXXXX", "........."],
  "/dashboard/settings": ["..X......", "XXXXXXXXX", "..X......", "......X..", "XXXXXXXXX", "......X..", "...X.....", "XXXXXXXXX", "...X....."],
};
const PATHS = Object.fromEntries(Object.entries(ICONS).map(([href, rows]) => [href, pixelPath(rows)]));

export function NavIcon({ href }: { href: string }) {
  const d = PATHS[href];
  if (!d) return null;
  return (
    <svg className="app-nav-icon" width="18" height="18" viewBox="0 0 9 9" shapeRendering="crispEdges" aria-hidden="true">
      <path d={d} fill="currentColor" />
    </svg>
  );
}

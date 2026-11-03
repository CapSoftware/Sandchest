import { mixHex, pixelPath } from "@/lib/pixel-art";
import { HOODIES, PHOSPHORS, swatch, type HackerProfile } from "@/lib/hacker";

/** The hood, the dark inside it and the two eyes, on a 14-pixel grid: the hacker's portrait. */
const ART = [
  ".....HHHH.....",
  "...HHHHHHHS...",
  "..HHHHHHHHSS..",
  ".HHHHHHHHHHSS.",
  ".HHHVVVVVVHSS.",
  "HHHVVVVVVVVHSS",
  "HHHVVEVVEVVHSS",
  "HHHVVEVVEVVHSS",
  "HHHVVVVVVVVHSS",
  "HHHHVVVVVVHHSS",
  "HHHHHVVVVHHHSS",
  ".HHHHHHHHHHSS.",
  "HHHHHHHHHHHHSS",
  "HHHHHHHHHHHHSS",
];
const PATHS = { hood: pixelPath(ART, "H"), shade: pixelPath(ART, "S"), void: pixelPath(ART, "V"), eyes: pixelPath(ART, "E") };

/**
 * A hacker as a 14-pixel portrait in their own hoodie and screen colour.
 * Everything they wear is near black, so the hood is lifted toward sand to
 * read at icon size; the eyes are the screen's colour.
 */
export function HackerMark({ profile, size = 28, className }: { profile: Pick<HackerProfile, "hoodie" | "phosphor">; size?: number; className?: string }) {
  const hood = mixHex(swatch(HOODIES, profile.hoodie).color, "#d9c4a0", 0.3);
  const eye = swatch(PHOSPHORS, profile.phosphor).color;
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 14 14" shapeRendering="crispEdges" aria-hidden="true">
      <path d={PATHS.hood} fill={hood} />
      <path d={PATHS.shade} fill={mixHex(hood, "#000000", 0.35)} />
      <path d={PATHS.void} fill="#050403" />
      <path d={PATHS.eyes} fill={eye} />
    </svg>
  );
}

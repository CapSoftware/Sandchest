/* eslint-disable @next/next/no-img-element */

/* ----------------------------------------------------------------------------
   Real brand marks for the agents Sandchest works with. The SVGs live in
   /public/logos and are served as static files (they carry their own fills and,
   for OpenCode, an internal mask, so each renders as its own <img> document,
   which also keeps their gradient/mask ids from colliding).
---------------------------------------------------------------------------- */

export type BrandLogo = { name: string; src: string };

export const brandLogos: BrandLogo[] = [
  { name: "Claude Code", src: "/logos/claude.svg" },
  { name: "Cursor", src: "/logos/cursor.svg" },
  { name: "Codex", src: "/logos/openai.svg" },
  { name: "OpenCode", src: "/logos/opencode.svg" },
];

export function BrandMark({
  src,
  className = "",
}: {
  src: string;
  className?: string;
}) {
  // alt="" because the visible name sits beside the mark, so it's decorative here
  return (
    <img src={src} alt="" loading="lazy" decoding="async" className={className} />
  );
}

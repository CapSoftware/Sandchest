"use client";

import { type ReactNode, useState } from "react";
import { cn } from "@/lib/utils";
import { useReducedMotionSafe } from "@/lib/use-reduced-motion-safe";
import { ChestFog } from "./chest-fog";
import { useWaitlist } from "./waitlist";

const sizes = {
  md: { pill: "gap-3 py-2 pl-5 pr-3", label: "text-base", sublabel: "text-sm" },
  lg: {
    pill: "gap-3 py-3 pl-5 pr-4 sm:gap-3.5 sm:py-3.5 sm:pl-7 sm:pr-5",
    label: "text-base sm:text-lg",
    sublabel: "text-sm sm:text-base",
  },
} as const;

export function ChestButton({
  href,
  onClick,
  type = "button",
  disabled = false,
  label = "Get your Sandchest key",
  sublabel,
  arrow = true,
  size = "md",
  className = "",
}: {
  href?: string;
  onClick?: () => void;
  /** "submit" turns it into a form submit button (used inside the waitlist form) */
  type?: "button" | "submit";
  disabled?: boolean;
  label?: ReactNode;
  sublabel?: ReactNode;
  /** show the trailing arrow (off for the form submit) */
  arrow?: boolean;
  size?: keyof typeof sizes;
  className?: string;
}) {
  const dims = sizes[size];
  const [hot, setHot] = useState(false);
  const reduce = useReducedMotionSafe();
  const { openWaitlist } = useWaitlist();

  // Default behaviour for a plain key button (no link, no explicit handler, not a
  // form submit): open the shared waitlist dialog.
  const handleClick =
    onClick ?? (!href && type === "button" ? openWaitlist : undefined);

  // Shared visuals/handlers; the pill is an <a> when it links and a <button>
  // otherwise (an action trigger or a form submit).
  const shared = {
    onMouseEnter: () => setHot(true),
    onMouseLeave: () => setHot(false),
    onFocus: () => setHot(true),
    onBlur: () => setHot(false),
    className: cn(
      "chest-btn focusable group inline-flex cursor-pointer items-center text-fg disabled:cursor-not-allowed disabled:opacity-70",
      dims.pill,
      className,
    ),
  };

  const inner = (
    <>
      {/* loot beam — a soft column of light rising out of the pill, the way a
          Fortnite chest pours light upward. Quiet at rest, floods on hover. */}
      <span aria-hidden className="chest-beam" />

      {/* warm orange aura that breathes at rest and flares on hover */}
      <span aria-hidden className="chest-aura" />

      {/* glowing gold fog spilling out of the chest and falling past the lip:
          a gentle wisp at rest, a full pour on hover. WebGL2; renders nothing
          under reduced motion or without WebGL2, leaving the CSS glow above. */}
      <ChestFog hot={hot} reduce={reduce} />

      {/* the label sits above the fog (z-2) and the shader holds the glow off
          the button face, but a soft dark halo guarantees contrast on hover */}
      <span
        className={cn("relative z-[2] font-medium", dims.label)}
        style={{ textShadow: "0 1px 11px rgba(6,3,1,0.7), 0 0 2px rgba(6,3,1,0.6)" }}
      >
        {label}
      </span>
      {sublabel ? (
        <span
          className={cn("relative z-[2] font-mono text-muted", dims.sublabel)}
          style={{ textShadow: "0 1px 10px rgba(6,3,1,0.65)" }}
        >
          {sublabel}
        </span>
      ) : null}
      {arrow ? (
        <span aria-hidden className="relative z-[2] text-muted">
          &rarr;
        </span>
      ) : null}
    </>
  );

  if (href) {
    return (
      <a href={href} {...shared}>
        {inner}
      </a>
    );
  }

  return (
    <button type={type} disabled={disabled} onClick={handleClick} {...shared}>
      {inner}
    </button>
  );
}

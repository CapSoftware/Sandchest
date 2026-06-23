import * as React from "react";
import { cn } from "@/lib/utils";
import type { Accent } from "@/lib/data";

const accentStyles: Record<Accent, string> = {
  accent: "text-accent border-accent/30",
  neutral: "text-muted border-line",
  emerald: "text-emerald border-emerald/30",
};

export function Badge({
  accent = "neutral",
  className,
  children,
}: {
  accent?: Accent;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border bg-white/[0.02] px-2.5 py-0.5 font-mono text-[0.66rem] uppercase tracking-[0.08em]",
        accentStyles[accent],
        className,
      )}
    >
      {children}
    </span>
  );
}

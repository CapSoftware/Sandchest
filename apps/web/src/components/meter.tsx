import { cn } from "@/lib/utils";
import type { Accent } from "@/lib/data";

const fillByAccent: Record<Accent, string> = {
  accent: "bg-accent",
  neutral: "bg-fg-soft/45",
  emerald: "bg-emerald",
};

/** Thin progress bar. */
export function Meter({
  value,
  accent = "accent",
  className,
}: {
  value: number;
  accent?: Accent;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]",
        className,
      )}
      role="progressbar"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className={cn("h-full rounded-full", fillByAccent[accent])}
        style={{ width: `${value}%` }}
      />
    </div>
  );
}

/** Segmented block meter, e.g. ███░░░░░░░ */
export function BlockMeter({
  value,
  accent = "accent",
  segments = 12,
  className,
}: {
  value: number;
  accent?: Accent;
  segments?: number;
  className?: string;
}) {
  const filled = Math.round((value / 100) * segments);
  return (
    <div className={cn("flex gap-1", className)} aria-hidden="true">
      {Array.from({ length: segments }).map((_, i) => (
        <span
          key={i}
          className={cn(
            "h-2 flex-1 rounded-[2px]",
            i < filled ? fillByAccent[accent] : "bg-white/[0.06]",
          )}
        />
      ))}
    </div>
  );
}

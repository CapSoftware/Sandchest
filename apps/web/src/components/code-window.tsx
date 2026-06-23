import * as React from "react";
import { cn } from "@/lib/utils";
import { CopyButton } from "@/components/copy-button";

export function CodeWindow({
  title,
  copyValue,
  children,
  className,
  bodyClassName,
  tag,
}: {
  title: string;
  copyValue?: string;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  tag?: string;
}) {
  return (
    <div className={cn("panel overflow-hidden", className)}>
      <div className="flex items-center gap-3 border-b border-line bg-white/[0.015] px-4 py-2.5">
        <div className="flex items-center gap-1.5">
          <span className="win-dot bg-[#ff5f57]/80" />
          <span className="win-dot bg-[#febc2e]/80" />
          <span className="win-dot bg-[#28c840]/80" />
        </div>
        <span className="ml-1 truncate font-mono text-xs text-muted">
          {title}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {tag ? (
            <span className="hidden rounded-md border border-line px-2 py-0.5 font-mono text-[0.65rem] uppercase tracking-wider text-faint sm:inline">
              {tag}
            </span>
          ) : null}
          {copyValue ? <CopyButton value={copyValue} /> : null}
        </div>
      </div>
      <div
        className={cn(
          "overflow-x-auto p-4 font-mono text-[0.82rem] leading-relaxed",
          bodyClassName,
        )}
      >
        {children}
      </div>
    </div>
  );
}

/* Tiny token helpers for lightly-coloured snippets (no full highlighter). */
export const Tok = {
  key: ({ children }: { children: React.ReactNode }) => (
    <span className="text-accent">{children}</span>
  ),
  str: ({ children }: { children: React.ReactNode }) => (
    <span className="text-emerald">{children}</span>
  ),
  fn: ({ children }: { children: React.ReactNode }) => (
    <span className="text-fg">{children}</span>
  ),
  cmd: ({ children }: { children: React.ReactNode }) => (
    <span className="text-accent-2">{children}</span>
  ),
  dim: ({ children }: { children: React.ReactNode }) => (
    <span className="text-faint">{children}</span>
  ),
  flag: ({ children }: { children: React.ReactNode }) => (
    <span className="text-fg-soft">{children}</span>
  ),
};

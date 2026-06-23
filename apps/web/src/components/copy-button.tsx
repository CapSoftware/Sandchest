"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

export function CopyButton({
  value,
  label,
  className,
}: {
  value: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={copied ? "Copied" : label ?? "Copy to clipboard"}
      className={cn(
        "focusable inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-2.5 text-xs text-muted transition-colors hover:border-line-strong hover:text-fg",
        className,
      )}
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-emerald" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
      <span className="font-mono">{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}

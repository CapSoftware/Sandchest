"use client";
import { useState } from "react";

/** Copies `text` to the clipboard. */
export function CopyText({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState<boolean | undefined>();
  return (
    <button
      type="button"
      className="key key-primary key-glow"
      onClick={async () => {
        const ok = await navigator.clipboard.writeText(text).then(
          () => true,
          () => false,
        );
        setCopied(ok);
        setTimeout(() => setCopied(undefined), 1_800);
      }}
    >
      <span className="key-face" aria-live="polite">
        {copied === undefined ? label : copied ? "Copied" : "Select and copy it instead"}
      </span>
    </button>
  );
}

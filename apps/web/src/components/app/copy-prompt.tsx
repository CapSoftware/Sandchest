"use client";
import { useState } from "react";
import { promptTaken } from "@/server/actions";
import { useDemo } from "./demo";

/** The one-click version of the fix prompt panel, for the top of the page. */
export function CopyPrompt({ findingId, prompt }: { findingId: string; prompt: string }) {
  const [copied, setCopied] = useState(false);
  const demo = useDemo();
  return (
    <button
      type="button"
      className="key key-primary key-glow"
      data-track="copy-fix-prompt"
      onClick={async () => {
        await navigator.clipboard.writeText(prompt);
        setCopied(true);
        setTimeout(() => setCopied(false), 1_800);
        if (!demo) void promptTaken(findingId);
      }}
    >
      <span className="key-face">{copied ? "Copied" : "Copy fix prompt"}</span>
    </button>
  );
}

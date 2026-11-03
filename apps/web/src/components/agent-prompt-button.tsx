"use client";
import { useRef, useState } from "react";
import { setupPrompt } from "@/lib/agent-prompt";

/** Copies the prompt that has the person's own agent set Sandchest up. */
export function AgentPromptButton({ className, track, label = "Set up with your agent" }: { className: string; track: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  async function copy() {
    const text = setupPrompt(window.location.origin);
    const ok = await navigator.clipboard.writeText(text).then(
      () => true,
      () => false,
    );
    // No clipboard (an old browser, a denied permission): let them copy it by hand.
    if (!ok) window.prompt("Copy this and paste it into your agent:", text);
    setCopied(ok);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2_400);
  }
  return (
    <button type="button" className={className} data-track={track} onClick={copy} title="Copies a prompt for Claude Code, Cursor, Codex or any coding agent">
      {/* Keys draw their face on an inner span; plain links don't have one. */}
      <span className={className.split(" ").includes("key") ? "key-face" : undefined} aria-live="polite">
        {copied ? "Copied. Paste it into your agent" : label}
      </span>
    </button>
  );
}

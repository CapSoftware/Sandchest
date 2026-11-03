"use client";
import { useRef, useState } from "react";
import { setupPrompt } from "@/lib/agent-prompt";

/** Copies the prompt that has the person's own agent set Sandchest up. */
/** `icon` draws a copy mark after the label that turns to a tick once copied. */
export function AgentPromptButton({
  className,
  track,
  label = "Set up with your agent",
  icon = false,
}: {
  className: string;
  track: string;
  label?: React.ReactNode;
  icon?: boolean;
}) {
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
      {/* Keys and buttons draw their face on an inner span; plain links don't have one. */}
      <span className={face(className)} aria-live="polite">
        {copied ? "Copied. Paste it into your agent" : label}
        {icon && (copied ? <TickIcon /> : <CopyIcon />)}
      </span>
    </button>
  );
}

function face(className: string): string | undefined {
  const classes = className.split(" ");
  if (classes.includes("key")) return "key-face";
  if (classes.includes("button")) return "button-face";
  return undefined;
}

/** Two overlapping sheets, drawn on the 16px pixel grid like the rest of the page. */
function CopyIcon() {
  return (
    <svg className="button-icon" viewBox="0 0 16 16" fill="currentColor" shapeRendering="crispEdges" aria-hidden="true">
      <path d="M5 1h9v2H7v8H5V1Zm9 0h1v10h-2V3h1V1Z" />
      <path d="M1 5h9v10H1V5Zm2 2v6h5V7H3Z" />
    </svg>
  );
}

function TickIcon() {
  return (
    <svg className="button-icon" viewBox="0 0 16 16" fill="currentColor" shapeRendering="crispEdges" aria-hidden="true">
      <path d="M13 3h2v2h-2V3Zm-2 2h2v2h-2V5Zm-2 2h2v2H9V7Zm-2 2h2v2H7V9Zm-2 2h2v2H5v-2Zm-2-2h2v2H3V9Zm-2-2h2v2H1V7Z" />
    </svg>
  );
}

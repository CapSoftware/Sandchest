"use client";
import { useState } from "react";
import { promptTaken } from "@/server/actions";

type Target = "prompt" | "claude" | "codex";

const TABS: Array<{ id: Target; label: string }> = [
  { id: "prompt", label: "Prompt" },
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
];

/** Cursor accepts prompts by link up to about 8,000 characters. */
const CURSOR_LIMIT = 8_000;

/** A quoted heredoc passes the prompt to the agent's CLI byte for byte, whatever it contains. */
function oneLiner(command: string, prompt: string): string {
  return `${command} "$(cat <<'SANDCHEST'\n${prompt}\nSANDCHEST\n)"`;
}

export function FixPrompt({ findingId, prompt }: { findingId: string; prompt: string }) {
  const [target, setTarget] = useState<Target>("prompt");
  const [copied, setCopied] = useState<Target | undefined>();
  const text = target === "prompt" ? prompt : oneLiner(target, prompt);
  const cursor = `https://cursor.com/link/prompt?text=${encodeURIComponent(prompt)}`;

  async function copy() {
    await navigator.clipboard.writeText(text);
    setCopied(target);
    setTimeout(() => setCopied((current) => (current === target ? undefined : current)), 1_800);
    void promptTaken(findingId);
  }

  return (
    <section className="prompt" aria-labelledby="prompt-title">
      <header className="prompt-head">
        <h2 id="prompt-title" className="prompt-title">
          Fix it with your agent
        </h2>
        <div className="tabs" role="tablist" aria-label="Format">
          {TABS.map((tab) => (
            <button key={tab.id} type="button" role="tab" aria-selected={target === tab.id} className="tab" onClick={() => setTarget(tab.id)}>
              {tab.label}
            </button>
          ))}
        </div>
      </header>
      <pre className="prompt-text" tabIndex={0}>
        {text}
      </pre>
      <div className="prompt-actions">
        <button type="button" className="key key-primary" onClick={copy}>
          <span className="key-face">{copied === target ? "Copied" : target === "prompt" ? "Copy prompt" : "Copy command"}</span>
        </button>
        {cursor.length <= CURSOR_LIMIT && (
          <a className="key key-secondary" href={cursor} target="_blank" rel="noreferrer" onClick={() => void promptTaken(findingId)}>
            <span className="key-face">Open in Cursor</span>
          </a>
        )}
      </div>
    </section>
  );
}

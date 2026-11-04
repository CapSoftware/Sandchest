"use client";
import { useState } from "react";
import { AGENT_APPS, AGENT_NAME, agentCommand, agentOpening, openAgent, pasteNote } from "@/lib/agent-links";
import { promptTaken } from "@/server/actions";
import { AgentLogo } from "./agent-logo";
import { useDemo } from "./demo";

type Target = "prompt" | "claude" | "codex";

const TABS: Array<{ id: Target; label: string }> = [
  { id: "prompt", label: "Prompt" },
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
];

/** The fix prompt: open it in a coding agent, or copy it as a prompt or a terminal command. */
export function FixPrompt({ findingId, prompt, repo }: { findingId: string; prompt: string; repo: string }) {
  const [target, setTarget] = useState<Target>("prompt");
  const demo = useDemo();
  const [copied, setCopied] = useState<Target | undefined>();
  const text = target === "prompt" ? prompt : agentCommand(target, prompt);
  const [note, setNote] = useState<string | undefined>();
  const openings = AGENT_APPS.map((app) => ({ app, opening: agentOpening(app, prompt, repo) }));

  async function copy() {
    await navigator.clipboard.writeText(text);
    setCopied(target);
    setTimeout(() => setCopied((current) => (current === target ? undefined : current)), 1_800);
    if (!demo) void promptTaken(findingId);
  }

  return (
    <section className="prompt" aria-labelledby="prompt-title">
      <header className="prompt-head">
        <h2 id="prompt-title" className="prompt-title">
          Fix it with your agent
        </h2>
        <div className="tabs" role="tablist" aria-label="Format">
          {TABS.map((tab) => (
            <button key={tab.id} type="button" role="tab" aria-selected={target === tab.id} className="tab tab-agent" onClick={() => setTarget(tab.id)} data-track={`fix-prompt-tab-${tab.id}`}>
              {tab.id !== "prompt" && <AgentLogo app={tab.id} />}
              {tab.label}
            </button>
          ))}
        </div>
      </header>
      <pre className="prompt-text" tabIndex={0}>
        {text}
      </pre>
      <div className="prompt-actions">
        <button type="button" className="key key-primary" onClick={copy} data-track={`fix-prompt-copy-${target}`}>
          <span className="key-face">{copied === target ? "Copied" : target === "prompt" ? "Copy prompt" : "Copy command"}</span>
        </button>
        {openings.map(({ app, opening }) => (
          <a
            key={app}
            className="key key-secondary"
            href={opening.href}
            title={opening.paste ? `Too long for a link: copies the prompt, then opens ${AGENT_NAME[app]} to paste it in` : undefined}
            onClick={(event) => {
              if (!demo) void promptTaken(findingId);
              setNote(undefined);
              // A prompt that fits goes in the link; one that doesn't goes on the clipboard first.
              if (!opening.paste) return;
              event.preventDefault();
              void openAgent(opening).then((ok) => setNote(pasteNote(app, ok)));
            }}
            data-track={`fix-prompt-open-${app}`}
          >
            <span className="key-face">
              <AgentLogo app={app} />
              Open in {AGENT_NAME[app]}
            </span>
          </a>
        ))}
        {note && (
          <p className="prompt-note" role="status">
            {note}
          </p>
        )}
      </div>
    </section>
  );
}

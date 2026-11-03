"use client";
import { useState } from "react";
import { AGENT_APPS, AGENT_NAME, agentCommand, agentLink } from "@/lib/agent-links";
import { promptTaken } from "@/server/actions";
import { AgentLogo } from "./agent-logo";

type Target = "prompt" | "claude" | "codex";

const TABS: Array<{ id: Target; label: string }> = [
  { id: "prompt", label: "Prompt" },
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
];

/** The fix prompt: open it in a coding agent, or copy it as a prompt or a terminal command. */
export function FixPrompt({ findingId, prompt, repo }: { findingId: string; prompt: string; repo: string }) {
  const [target, setTarget] = useState<Target>("prompt");
  const [copied, setCopied] = useState<Target | undefined>();
  const text = target === "prompt" ? prompt : agentCommand(target, prompt);
  const links = AGENT_APPS.map((app) => ({ app, href: agentLink(app, prompt, repo) }));
  const tooLong = links.filter((link) => !link.href).map((link) => AGENT_NAME[link.app]);

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
        {links.map(
          ({ app, href }) =>
            href && (
              <a key={app} className="key key-secondary" href={href} onClick={() => void promptTaken(findingId)} data-track={`fix-prompt-open-${app}`}>
                <span className="key-face">
                  <AgentLogo app={app} />
                  Open in {AGENT_NAME[app]}
                </span>
              </a>
            ),
        )}
        {tooLong.length > 0 && <p className="prompt-note">Too long to open in {list(tooLong)} by link. Copy it instead.</p>}
      </div>
    </section>
  );
}

/** "A", "A or B", "A, B or C". */
function list(names: string[]): string {
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;
}

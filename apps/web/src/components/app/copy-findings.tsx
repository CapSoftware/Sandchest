"use client";
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { AGENT_APPS, AGENT_NAME, agentCommand, agentOpening, COMMAND_ARGUMENT_LIMIT, openAgent, pasteNote, type AgentApp, type AgentOpening } from "@/lib/agent-links";
import { copyFindings, findingsPrompt, findingsTaken, type ExportFiltersInput } from "@/server/actions";
import { AgentLogo } from "./agent-logo";
import { useDemo } from "./demo";

type CopyFormat = "prompt" | "claude" | "codex" | "markdown" | "json";

const AGENT_COPIES: Array<{ id: "prompt" | "claude" | "codex"; label: string; hint: string }> = [
  { id: "prompt", label: "Prompt", hint: "Paste into any coding agent" },
  { id: "claude", label: "Claude Code command", hint: "For your terminal" },
  { id: "codex", label: "Codex command", hint: "For your terminal" },
];

const DOCUMENTS: Array<{ id: "markdown" | "json"; label: string; hint: string }> = [
  { id: "markdown", label: "Markdown", hint: "A report for an issue, doc or chat" },
  { id: "json", label: "JSON", hint: "For scripts and tools" },
];

/** The agent prompt for the list, built on the server. */
type Prepared = { text: string; ids: string[]; repos: string[] };

/** The server turned the request down, with a reason worth showing. */
class Refused extends Error {}

type State = { phase: "idle" } | { phase: "copying"; format: CopyFormat } | { phase: "copied"; count: number; note?: string } | { phase: "failed"; message: string };

/**
 * Hands every finding the list shows, with its filters, to a coding agent:
 * opened in an app, or copied as a prompt or a terminal command. Or copies
 * them as a document. The agent prompt is prepared when the menu opens, so an
 * "Open in" link is a plain link by the time it's clicked.
 */
export function CopyFindings(props: { filters: ExportFiltersInput; count: number }) {
  // The demo's findings aren't anyone's to hand over: the server has none of them.
  return useDemo() ? null : <CopyMenu {...props} />;
}

function CopyMenu({ filters, count }: { filters: ExportFiltersInput; count: number }) {
  const menu = useRef<HTMLDetailsElement>(null);
  const [state, setState] = useState<State>({ phase: "idle" });
  const [prepared, setPrepared] = useState<Prepared | "failed" | undefined>();
  const pending = useRef<Promise<Prepared> | undefined>(undefined);
  const forOpen = filters.status === "open";
  const key = JSON.stringify(filters);

  // A filter change keeps this mounted with new props: what was prepared is for the old list.
  useEffect(() => {
    pending.current = undefined;
    setPrepared(undefined);
    setState({ phase: "idle" });
  }, [key]);

  // A details element stays open until its summary is clicked again; a menu should close on a click elsewhere or Escape.
  useEffect(() => {
    const close = (event: Event) => {
      const details = menu.current;
      if (!details?.open) return;
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !details.contains(event.target as Node)) details.removeAttribute("open");
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, []);

  function prepare(): Promise<Prepared> {
    if (!pending.current) {
      const request = findingsPrompt(filters).then((outcome) => {
        if ("error" in outcome) throw new Refused(outcome.error);
        return outcome;
      });
      pending.current = request;
      request.then(
        (value) => pending.current === request && setPrepared(value),
        () => pending.current === request && setPrepared("failed"),
      );
    }
    return pending.current;
  }

  async function copy(format: CopyFormat) {
    setState({ phase: "copying", format });
    const agent = format === "prompt" || format === "claude" || format === "codex";
    const result: Promise<{ text: string; count: number; ids?: string[] }> = agent
      ? prepare().then((value) => ({ text: format === "prompt" ? value.text : agentCommand(format, value.text), count: value.ids.length, ids: value.ids }))
      : copyFindings(filters, format).then((outcome) => {
          if ("error" in outcome) throw new Refused(outcome.error);
          return outcome;
        });
    try {
      await write(result.then((outcome) => outcome.text));
      const outcome = await result;
      if (outcome.ids) void findingsTaken(filters, outcome.ids, format as "prompt" | "claude" | "codex");
      const note = format !== "prompt" && agent && outcome.text.length > COMMAND_ARGUMENT_LIMIT ? "Copied. That command may be too long for a Linux shell. Filter by repository, or copy the Prompt and paste it in." : undefined;
      // A note stays up in the open menu until it closes; otherwise the menu gets out of the way.
      if (!note) menu.current?.removeAttribute("open");
      setState({ phase: "copied", count: outcome.count, note });
      if (!note) setTimeout(() => setState((current) => (current.phase === "copied" ? { phase: "idle" } : current)), 2_000);
    } catch {
      // The server's reason when it refused; otherwise the clipboard said no.
      const refused = await result.then(
        () => undefined,
        (error: unknown) => (error instanceof Refused ? error.message : undefined),
      );
      setState({ phase: "failed", message: refused ?? "Couldn’t copy. Try again." });
    }
  }

  function opened(event: MouseEvent, app: AgentApp, opening: AgentOpening) {
    if (!ready) return;
    void findingsTaken(filters, ready.ids, `open_${app}`);
    // A prompt that fits goes in the link; one that doesn't goes on the clipboard first, and the menu says to paste it.
    if (!opening.paste) {
      menu.current?.removeAttribute("open");
      return;
    }
    event.preventDefault();
    void openAgent(opening).then((ok) => setState({ phase: "copied", count: ready.ids.length, note: pasteNote(app, ok) }));
  }

  const ready = prepared && prepared !== "failed" ? prepared : undefined;
  const repo = ready?.repos.length === 1 ? ready.repos[0] : undefined;
  const links = AGENT_APPS.map((app) => ({ app, opening: ready && repo ? agentOpening(app, ready.text, repo) : undefined }));
  const reason = !forOpen
    ? undefined
    : prepared === undefined
      ? "Preparing the prompt…"
      : prepared === "failed"
        ? "Couldn’t prepare the prompt. Close the menu and try again."
        : !repo
          ? "These span more than one repository. Filter to one to open them in an app."
          : undefined;
  const label = state.phase === "copied" ? `Copied ${state.count === 1 ? "1 finding" : `${state.count} findings`}` : `Copy ${count === 1 ? "finding" : `${count} findings`}`;

  return (
    <details
      ref={menu}
      className="copy-findings"
      onToggle={(event) => {
        if (event.currentTarget.open) {
          if (forOpen) void prepare().catch(() => undefined);
          return;
        }
        // Closing the menu clears what it was saying; a plain "Copied" on the button stays.
        setState((current) => (current.phase === "failed" || (current.phase === "copied" && current.note) ? { phase: "idle" } : current));
        // A failed preparation is tried again next time.
        if (prepared === "failed") {
          pending.current = undefined;
          setPrepared(undefined);
        }
      }}
    >
      <summary className="key key-secondary" data-track="findings-copy-open">
        <span className="key-face" aria-live="polite">
          {label}
          <span aria-hidden="true" className="copy-findings-caret">
            ▾
          </span>
        </span>
      </summary>
      <div className="copy-findings-menu">
        {forOpen && (
          <>
            <p>Open in</p>
            <div className="open-grid">
              {links.map(({ app, opening }) =>
                opening ? (
                  <a
                    key={app}
                    className="menu-item open-item"
                    href={opening.href}
                    title={opening.paste ? `Too long for a link: copies the prompt, then opens ${AGENT_NAME[app]} to paste it in` : undefined}
                    onClick={(event) => opened(event, app, opening)}
                    data-track={`findings-open-${app}`}
                  >
                    <AgentLogo app={app} />
                    {AGENT_NAME[app]}
                  </a>
                ) : (
                  <span key={app} className="menu-item open-item" aria-disabled="true">
                    <AgentLogo app={app} />
                    {AGENT_NAME[app]}
                  </span>
                ),
              )}
            </div>
            {reason && <p className="copy-findings-reason">{reason}</p>}
          </>
        )}
        <p>{forOpen ? "Copy" : "Copy as"}</p>
        {forOpen && AGENT_COPIES.map((format) => <Item key={format.id} format={format} state={state} onCopy={copy} logo={format.id === "prompt" ? undefined : format.id} />)}
        {DOCUMENTS.map((format) => (
          <Item key={format.id} format={format} state={state} onCopy={copy} />
        ))}
        {state.phase === "copied" && state.note && (
          <p className="copy-findings-error copy-findings-note" role="status">
            {state.note}
          </p>
        )}
        {state.phase === "failed" && (
          <p className="copy-findings-error" role="alert">
            {state.message}
          </p>
        )}
      </div>
    </details>
  );
}

function Item({ format, state, onCopy, logo }: { format: { id: CopyFormat; label: string; hint: string }; state: State; onCopy: (format: CopyFormat) => void; logo?: AgentApp }) {
  const busy = state.phase === "copying";
  return (
    <button type="button" className="menu-item copy-findings-item" disabled={busy} onClick={() => onCopy(format.id)} data-track={`findings-copy-${format.id}`}>
      <span className="copy-findings-icon">{logo && <AgentLogo app={logo} />}</span>
      <span>{busy && state.format === format.id ? "Copying…" : format.label}</span>
      <span className="copy-findings-hint">{format.hint}</span>
    </button>
  );
}

/**
 * Writes text that is still on its way. Safari only lets the clipboard be
 * written during the click, so the pending text goes in as a promise there;
 * elsewhere it falls back to writing it once it arrives.
 */
async function write(text: Promise<string>): Promise<void> {
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    try {
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": text.then((value) => new Blob([value], { type: "text/plain" })) })]);
      return;
    } catch (error) {
      // A failed request rejects the promise: report that, not the clipboard.
      await text;
      if (!(error instanceof DOMException)) throw error;
    }
  }
  await navigator.clipboard.writeText(await text);
}

"use client";
import { useEffect, useRef, useState } from "react";
import type { ExportFormat } from "@/lib/findings-export";
import { copyFindings, type ExportFiltersInput } from "@/server/actions";

const AGENT: Array<{ id: ExportFormat; label: string; hint: string }> = [
  { id: "prompt", label: "Prompt", hint: "Paste into any coding agent" },
  { id: "claude", label: "Claude Code", hint: "A claude command for your terminal" },
  { id: "codex", label: "Codex", hint: "A codex command for your terminal" },
];

const DOCUMENT: Array<{ id: ExportFormat; label: string; hint: string }> = [
  { id: "markdown", label: "Markdown", hint: "A report for an issue, doc or chat" },
  { id: "json", label: "JSON", hint: "For scripts and tools" },
];

/** The server turned the export down, with a reason worth showing. */
class Refused extends Error {}

type State = { phase: "idle" } | { phase: "copying"; format: ExportFormat } | { phase: "copied"; count: number; note?: string } | { phase: "failed"; message: string };

/**
 * Copies every finding the list shows, with its filters, as a prompt for a
 * coding agent or as a document. The text is built on the server when asked
 * for, so the page never carries it.
 */
export function CopyFindings({ filters, count }: { filters: ExportFiltersInput; count: number }) {
  const menu = useRef<HTMLDetailsElement>(null);
  const [state, setState] = useState<State>({ phase: "idle" });
  const open = filters.status === "open";

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

  async function copy(format: ExportFormat) {
    setState({ phase: "copying", format });
    const result = copyFindings(filters, format).then((outcome) => {
      if ("error" in outcome) throw new Refused(outcome.error);
      return outcome;
    });
    try {
      await write(result.then((outcome) => outcome.text));
      const { count: copied, note } = await result;
      // A note stays up in the open menu until it closes; otherwise the menu gets out of the way.
      if (!note) menu.current?.removeAttribute("open");
      setState({ phase: "copied", count: copied, note });
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

  const label = state.phase === "copied" ? `Copied ${state.count === 1 ? "1 finding" : `${state.count} findings`}` : `Copy ${count === 1 ? "finding" : `${count} findings`}`;

  return (
    <details ref={menu} className="copy-findings" onToggle={(event) => {
        // Closing the menu clears what it was saying; a plain "Copied" on the button stays.
        if (!event.currentTarget.open) setState((current) => (current.phase === "failed" || (current.phase === "copied" && current.note) ? { phase: "idle" } : current));
      }}>
      <summary className="key key-secondary" data-track="findings-copy-open">
        <span className="key-face" aria-live="polite">
          {label}
          <span aria-hidden="true" className="copy-findings-caret">
            ▾
          </span>
        </span>
      </summary>
      <div className="copy-findings-menu">
        {open && (
          <>
            <p>Fix them with your agent</p>
            {AGENT.map((format) => (
              <Item key={format.id} format={format} state={state} onCopy={copy} />
            ))}
          </>
        )}
        <p>{open ? "Or copy them as" : "Copy them as"}</p>
        {DOCUMENT.map((format) => (
          <Item key={format.id} format={format} state={state} onCopy={copy} />
        ))}
        {state.phase === "copied" && state.note && (
          <p className="copy-findings-error" role="status">
            Copied. {state.note}
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

function Item({ format, state, onCopy }: { format: (typeof AGENT)[number]; state: State; onCopy: (format: ExportFormat) => void }) {
  const busy = state.phase === "copying";
  return (
    <button type="button" className="menu-item copy-findings-item" disabled={busy} onClick={() => onCopy(format.id)} data-track={`findings-copy-${format.id}`}>
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
      // A failed export rejects the promise: report that, not the clipboard.
      await text;
      if (!(error instanceof DOMException)) throw error;
    }
  }
  await navigator.clipboard.writeText(await text);
}

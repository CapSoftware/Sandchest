"use client";
import { useRef, useState, type ComponentProps } from "react";

/** Shows "Copied" for a moment after a successful copy, or what went wrong. */
function useCopied(): [string | undefined, (label: string) => void] {
  const [note, setNote] = useState<string | undefined>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  return [
    note,
    (label: string) => {
      setNote(label);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setNote(undefined), 1_800);
    },
  ];
}

/**
 * Copies the page's Markdown, fetched on click. The clipboard write starts
 * inside the click (Safari requires it) and waits for the fetch.
 */
export function CopyMarkdown({ href }: { href: string }) {
  const [note, flash] = useCopied();
  async function copy() {
    const text = fetch(href).then((response) => {
      if (!response.ok) throw new Error(String(response.status));
      return response.text();
    });
    try {
      if (typeof ClipboardItem !== "undefined" && navigator.clipboard.write) {
        await navigator.clipboard.write([new ClipboardItem({ "text/plain": text.then((value) => new Blob([value], { type: "text/plain" })) })]);
      } else {
        await navigator.clipboard.writeText(await text);
      }
      flash("Copied");
    } catch {
      flash("Couldn’t copy: use View Markdown");
    }
  }
  return (
    <button type="button" className="docs-key" onClick={copy} aria-live="polite" data-track="docs-copy-markdown">
      <span className="docs-key-face">{note ?? "Copy as Markdown"}</span>
    </button>
  );
}

/** A code block with a copy button. The text comes from the rendered block, so it is exactly what is shown. */
export function CodeBlock({ children, ...props }: ComponentProps<"pre">) {
  const ref = useRef<HTMLPreElement>(null);
  const [note, flash] = useCopied();
  return (
    <div className="code">
      <pre ref={ref} tabIndex={0} {...props}>
        {children}
      </pre>
      <button
        type="button"
        className="code-copy"
        data-track="docs-copy-code"
        aria-live="polite"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(ref.current?.innerText.replace(/\n$/, "") ?? "");
            flash("Copied");
          } catch {
            flash("Couldn’t copy");
          }
        }}
      >
        {note ?? "Copy"}
      </button>
    </div>
  );
}

"use client";
import { useEffect, useRef, useState } from "react";

/**
 * Narrows a server-rendered list as you type: rows whose `data-name` doesn't
 * contain the text are hidden. The rows stay server-rendered, so their times
 * and links never differ between server and browser.
 */
export function ListFilter({ list, label, placeholder }: { list: string; label: string; placeholder: string }) {
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState<number | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const rows = document.querySelectorAll<HTMLElement>(`#${list} > [data-name]`);
    const needle = query.trim().toLowerCase();
    let count = 0;
    rows.forEach((row) => {
      const match = !needle || (row.dataset.name ?? "").includes(needle);
      row.hidden = !match;
      if (match) count++;
    });
    setShown(needle ? count : null);
  }, [list, query]);

  // "/" jumps to the filter, as on GitHub.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.key !== "/" || target?.closest("input, textarea, select, [contenteditable]")) return;
      event.preventDefault();
      input.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="list-filter">
      <label className="sr-only" htmlFor={`${list}-filter`}>
        {label}
      </label>
      <input ref={input} id={`${list}-filter`} type="search" className="input list-filter-input" placeholder={placeholder} value={query} onChange={(event) => setQuery(event.target.value)} autoComplete="off" spellCheck={false} />
      <span className="list-filter-count" aria-live="polite">
        {shown === null ? "" : shown === 0 ? "No match" : `${shown} shown`}
      </span>
    </div>
  );
}

"use client";
import type { ReactNode } from "react";
import { useFormStatus } from "react-dom";

/**
 * A submit button that shows it is working while its form's action runs.
 * `bare` renders the label without the key face, for menu items.
 */
export function Submit({ children, pending, className = "key key-secondary", name, value, bare = false }: { children: ReactNode; pending?: ReactNode; className?: string; name?: string; value?: string; bare?: boolean }) {
  const status = useFormStatus();
  const busy = status.pending && (name === undefined || status.data?.get(name) === value);
  const label = busy && pending ? pending : children;
  return (
    <button type="submit" className={className} name={name} value={value} disabled={status.pending} aria-busy={busy || undefined}>
      {bare ? label : <span className="key-face">{label}</span>}
    </button>
  );
}

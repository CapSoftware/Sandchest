import type { ReactNode } from "react";
import "./cap-key.css";

/** A keyboard key's legend, printed on a small keycap: the shortcut for the button it sits in. Hidden on touch screens. */
export function Keycap({ children }: { children: ReactNode }) {
  return (
    <kbd className="keycap" aria-hidden="true">
      {children}
    </kbd>
  );
}

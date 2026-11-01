import type { ReactNode } from "react";

/** The setup pages' frame: the sign-in page's, with room for a form. */
export function SetupShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="sign-in setup">
      <div className="shell">
        <a href="/" className="sign-in-mark" aria-label="Sandchest home">
          <img src="/sandchest-logo-dark.svg" alt="Sandchest" width={184} height={34} />
        </a>
        <h1 className="sign-in-title">{title}</h1>
        {children}
      </div>
    </main>
  );
}

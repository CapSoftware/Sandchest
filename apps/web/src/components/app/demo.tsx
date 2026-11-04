"use client";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";

/**
 * The demo at /demo draws the dashboard's own views from a made-up account.
 * Inside it, every dashboard link leads to the demo's copy of that page, and
 * anything that would change something (a form, a Dig, a GitHub link to an
 * account that doesn't exist) is stopped with a note that this is a demo.
 */

const DemoBase = createContext<string | null>(null);

/** True inside the demo. */
export function useDemo(): boolean {
  return useContext(DemoBase) !== null;
}

const DASHBOARD = "/dashboard";

/** A dashboard path as the demo serves it; anything else as it is. */
export function inDemo(href: string, base: string): string {
  return href === DASHBOARD || href.startsWith(`${DASHBOARD}/`) || href.startsWith(`${DASHBOARD}?`) || href.startsWith(`${DASHBOARD}#`) ? base + href.slice(DASHBOARD.length) : href;
}

/** `href` where it leads from here: in the demo, its copy of a dashboard page. */
export function useHref<T>(href: T): T {
  const base = useContext(DemoBase);
  return base && typeof href === "string" ? (inDemo(href, base) as T) : href;
}

/** The current path, with the demo's pages named by the dashboard paths they copy, so the nav lights the same section. */
export function useDashboardPath(): string {
  const base = useContext(DemoBase);
  const path = usePathname();
  return base && (path === base || path.startsWith(`${base}/`)) ? DASHBOARD + path.slice(base.length) : path;
}

const NOTES = {
  save: "This is a demo, so nothing here is saved or started.",
  github: "acme is a made-up account, so there’s nothing to open on GitHub.",
};

export function DemoProvider({ base, getStarted, children }: { base: string; getStarted: string; children: ReactNode }) {
  const router = useRouter();
  const [note, setNote] = useState<{ text: string; n: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const path = usePathname();

  // A note is about the page it was raised on.
  useEffect(() => setNote(null), [path]);

  useEffect(() => {
    const show = (text: string) => {
      setNote((current) => ({ text, n: (current?.n ?? 0) + 1 }));
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setNote(null), 4_000);
    };

    // Capture, on the document: these run before React's own handlers on the root, so a stopped form never reaches its action.
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      const link = (event.target as Element | null)?.closest?.("a[href]");
      if (!(link instanceof HTMLAnchorElement)) return;
      const href = link.getAttribute("href") ?? "";
      if (href.startsWith(DASHBOARD)) {
        event.preventDefault();
        event.stopPropagation();
        const to = inDemo(href, base);
        if (event.metaKey || event.ctrlKey || event.shiftKey) window.open(to, "_blank");
        else router.push(to);
      } else if (link.hostname === "github.com" && !link.pathname.startsWith("/apps/")) {
        // Installing the App is real, on the visitor's own account; anything of acme's on GitHub doesn't exist.
        event.preventDefault();
        event.stopPropagation();
        show(NOTES.github);
      }
    };
    const onSubmit = (event: SubmitEvent) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement)) return;
      event.preventDefault();
      event.stopPropagation();
      const action = form.getAttribute("action") ?? "";
      // A filter form is a plain GET to a dashboard page: follow it here. Anything else would change something.
      if (form.method === "get" && (action.startsWith(DASHBOARD) || action.startsWith(base))) {
        const query = new URLSearchParams();
        for (const [key, value] of new FormData(form, event.submitter)) if (typeof value === "string" && value) query.set(key, value);
        const path = inDemo(action, base);
        router.push(query.size ? `${path}?${query}` : path);
      } else show(NOTES.save);
    };
    document.addEventListener("click", onClick, true);
    document.addEventListener("submit", onSubmit, true);
    return () => {
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("submit", onSubmit, true);
      clearTimeout(timer.current);
    };
  }, [base, router]);

  return (
    <DemoBase.Provider value={base}>
      {children}
      <div className="demo-note-slot" aria-live="polite">
        {note && (
          <p key={note.n} className="demo-note">
            {note.text}{" "}
            <a href={getStarted} data-track="demo-note-get-started">
              Run it on your code
            </a>
          </p>
        )}
      </div>
    </DemoBase.Provider>
  );
}

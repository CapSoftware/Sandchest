"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FirstScan as ScanChoices } from "@/lib/first-scan";
import { ScanChooser } from "./first-scan";
import "./first-scan.css";

/** The room the launcher opens on, fetched as soon as the key is reached for so it is there when the dialog is. */
const SCENE = "/rig/still-onboard-high.webp";

/**
 * The Deep scan key in a page's head, and the launcher it opens: a dialog with the hacker's room, the
 * repositories to choose from, what the scan costs, and the key that starts it. The dialog is the browser's
 * own, so focus stays inside it and Esc closes it; a press on the dark around it closes it too. While a scan
 * is starting it stays put.
 */
export function ScanLauncher({ data }: { data: ScanChoices }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  // The chooser is drawn from the first opening on, so the page's HTML carries only the key.
  const [used, setUsed] = useState(false);
  const busy = useRef(false);
  const onBusy = useCallback((now: boolean) => {
    busy.current = now;
  }, []);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      element.showModal();
      // On a keyboard the filter is ready to type in; on touch, the chosen repository, so no keyboard slides up.
      const fields = [...element.querySelectorAll<HTMLElement>("[data-first-focus]")];
      (matchMedia("(pointer: fine)").matches ? fields[0] : fields.at(-1))?.focus({ preventScroll: true });
    } else if (!open && element.open) element.close();
  }, [open]);

  const warm = () => {
    new Image().src = SCENE;
  };

  return (
    <>
      <button
        type="button"
        className="key key-primary key-large key-glow scan-launcher-key"
        aria-haspopup="dialog"
        onClick={() => {
          setUsed(true);
          setOpen(true);
        }}
        onPointerEnter={warm}
        onFocus={warm}
        data-track="scan-launcher-open"
      >
        <span className="key-face">
          <Prompt />
          Deep scan
        </span>
      </button>
      <dialog
        ref={dialog}
        className="scan-launcher"
        aria-label="Start a deep scan"
        onClose={close}
        onCancel={(event) => {
          if (busy.current) event.preventDefault();
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget && !busy.current) close();
        }}
      >
        {used && (
          <div className="scan-launcher-body">
            <ScanChooser data={data} onClose={close} onBusy={onBusy} />
            <button type="button" className="scan-launcher-close" onClick={() => !busy.current && close()} aria-label="Close" data-track="scan-launcher-close">
              <svg width="14" height="14" viewBox="0 0 14 14" shapeRendering="crispEdges" aria-hidden="true">
                <path d="M2 2h2v2H2zM4 4h2v2H4zM6 6h2v2H6zM8 8h2v2H8zM10 10h2v2h-2zM10 2h2v2h-2zM8 4h2v2H8zM4 8h2v2H4zM2 10h2v2H2z" fill="currentColor" />
              </svg>
            </button>
          </div>
        )}
      </dialog>
    </>
  );
}

/** A shell prompt in pixels, its cursor blinking: the key runs a command. */
function Prompt() {
  return (
    <svg className="scan-launcher-prompt" width="18" height="12" viewBox="0 0 9 6" shapeRendering="crispEdges" aria-hidden="true">
      <path fill="currentColor" d="M0 0h1v1H0zM1 1h1v1H1zM2 2h1v1H2zM1 3h1v1H1zM0 4h1v1H0z" />
      <path className="scan-launcher-cursor" fill="currentColor" d="M4 4h4v1H4z" />
    </svg>
  );
}

"use client";

import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ChestButton } from "./chest-button";
import { ChestOpen } from "./chest-open";

type Status = "idle" | "submitting" | "success" | "error";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* A small deterministic ember burst for the success state — same warm palette
   as the chest, seeded by index so server and client agree. */
const EMBERS = Array.from({ length: 18 }, (_, i) => ({
  x: ((i * 53) % 200) - 100, // px spread left/right
  y: -36 - ((i * 37) % 120), // px upward travel
  size: 2 + (i % 3),
  delay: (((i * 29) % 100) / 100) * 0.22,
  duration: 0.9 + (i % 5) * 0.16,
  tone: ["#F5853F", "#F5A524", "#FEC242"][i % 3],
}));

export function WaitlistModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const reduce = useReducedMotion();
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

  // Reset the form whenever the modal transitions open. This is a render-time
  // state adjustment (the React-sanctioned alternative to a reset effect), not a
  // side effect, so it stays out of the effect below.
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setStatus("idle");
      setError(null);
      setEmail("");
    }
  }

  // DOM side effects: lock body scroll (compensating for the scrollbar width so
  // the page never shifts/scales), autofocus the input, and restore focus to the
  // trigger on close.
  useEffect(() => {
    if (!open) return;

    restoreRef.current = document.activeElement as HTMLElement | null;

    const { body } = document;
    const scrollbar = window.innerWidth - document.documentElement.clientWidth;
    const prevOverflow = body.style.overflow;
    const prevPad = body.style.paddingRight;
    body.style.overflow = "hidden";
    if (scrollbar > 0) body.style.paddingRight = `${scrollbar}px`;

    const focusTimer = window.setTimeout(() => inputRef.current?.focus(), 70);

    return () => {
      body.style.overflow = prevOverflow;
      body.style.paddingRight = prevPad;
      window.clearTimeout(focusTimer);
      restoreRef.current?.focus?.();
    };
  }, [open]);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab" || !panelRef.current) return;

    const focusable = panelRef.current.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const activeEl = document.activeElement;
    if (event.shiftKey && activeEl === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && activeEl === last) {
      event.preventDefault();
      first.focus();
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (status === "submitting") return;

    const value = email.trim();
    if (!EMAIL_RE.test(value)) {
      setStatus("error");
      setError("Enter a valid email address.");
      inputRef.current?.focus();
      return;
    }

    setStatus("submitting");
    setError(null);
    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: value }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? "Something went wrong.");
      }
      setStatus("success");
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Something went wrong.");
    }
  }

  const panelMotion = reduce
    ? {
        initial: { opacity: 0 },
        animate: { opacity: 1 },
        exit: { opacity: 0 },
        transition: { duration: 0.15 },
      }
    : {
        initial: { opacity: 0, scale: 0.94, y: 16 },
        animate: { opacity: 1, scale: 1, y: 0 },
        exit: { opacity: 0, scale: 0.97, y: 10 },
        transition: {
          type: "spring" as const,
          stiffness: 320,
          damping: 26,
          mass: 0.7,
        },
      };

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          onKeyDown={handleKeyDown}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
        >
          {/* backdrop — click to dismiss */}
          <button
            type="button"
            aria-label="Close"
            tabIndex={-1}
            onClick={onClose}
            className="absolute inset-0 cursor-default bg-black/75 backdrop-blur-sm"
          />

          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="waitlist-title"
            className="panel relative z-[1] w-full max-w-3xl overflow-hidden p-0"
            {...panelMotion}
          >
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="focusable absolute right-3 top-3 z-20 inline-flex h-8 w-8 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-fg"
            >
              <CloseIcon />
            </button>

            <div className="grid md:grid-cols-[1.05fr_0.95fr]">
              {/* form column */}
              <div className="order-2 flex flex-col justify-center p-7 sm:p-9 md:order-1">
                {status === "success" ? (
                  <Success email={email.trim()} reduce={!!reduce} onClose={onClose} />
                ) : (
                  <form onSubmit={handleSubmit} noValidate>
                    <h2
                      id="waitlist-title"
                      className="text-[1.75rem] font-semibold leading-[1.1] tracking-[-0.01em] text-fg"
                    >
                      Get your Sandchest key
                    </h2>
                    <p className="mt-3 text-sm leading-relaxed text-fg-soft">
                      Join the waitlist and we&rsquo;ll email your key the moment
                      the next wave opens. One key, every open coding model.
                    </p>

                    <div className="mt-6">
                      <label htmlFor="waitlist-email" className="sr-only">
                        Email address
                      </label>
                      <input
                        ref={inputRef}
                        id="waitlist-email"
                        name="email"
                        type="email"
                        inputMode="email"
                        autoComplete="email"
                        placeholder="you@company.com"
                        value={email}
                        onChange={(e) => {
                          setEmail(e.target.value);
                          if (status === "error") {
                            setStatus("idle");
                            setError(null);
                          }
                        }}
                        aria-invalid={status === "error"}
                        aria-describedby={error ? "waitlist-error" : undefined}
                        disabled={status === "submitting"}
                        /* 16px keeps mobile Safari from zooming/scaling on focus */
                        className="focusable h-11 w-full rounded-md border border-line-strong bg-surface px-3.5 text-[16px] text-fg placeholder:text-muted disabled:opacity-60"
                      />
                    </div>

                    {error ? (
                      <p
                        id="waitlist-error"
                        role="alert"
                        className="mt-2 text-sm text-[#ef8a63]"
                      >
                        {error}
                      </p>
                    ) : null}

                    {/* the confirm button carries the same gold-gas animation as
                        the hero key */}
                    <ChestButton
                      type="submit"
                      disabled={status === "submitting"}
                      label={status === "submitting" ? "Joining…" : "Join the waitlist"}
                      className="mt-5 w-full justify-center"
                    />

                    <p className="mt-3 text-xs text-faint">
                      No spam. One email when your key is ready.
                    </p>
                  </form>
                )}
              </div>

              {/* chest column — the reveal's final open state, looping, as the
                  payoff you&rsquo;re signing up for */}
              <div
                className="relative order-1 flex min-h-[208px] items-center justify-center overflow-hidden border-b border-line-strong md:order-2 md:min-h-0 md:border-b-0 md:border-l"
                style={{
                  background:
                    "radial-gradient(120% 100% at 50% 26%, rgba(74,40,13,0.55), rgba(17,13,9,0.96) 74%)",
                }}
              >
                <ChestOpen
                  reduce={!!reduce}
                  className="w-[88%] max-w-[300px] translate-y-[8%]"
                />
              </div>
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

function Success({
  email,
  reduce,
  onClose,
}: {
  email: string;
  reduce: boolean;
  onClose: () => void;
}) {
  return (
    <div className="relative text-center">
      {!reduce ? (
        <span
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-8 block h-0 w-0"
        >
          {EMBERS.map((e, i) => (
            <motion.span
              key={i}
              className="absolute block rounded-full"
              style={{ width: e.size, height: e.size, background: e.tone }}
              initial={{ opacity: 1, x: 0, y: 0, scale: 1 }}
              animate={{ opacity: 0, x: e.x, y: e.y, scale: 0.3 }}
              transition={{ duration: e.duration, delay: e.delay, ease: "easeOut" }}
            />
          ))}
        </span>
      ) : null}

      <motion.div
        initial={reduce ? false : { scale: 0.6, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: "spring", stiffness: 360, damping: 18 }}
        className="relative mx-auto flex h-12 w-12 items-center justify-center rounded-full border border-line-strong bg-surface text-accent"
        style={{ boxShadow: "0 0 30px -6px rgba(245,140,66,0.7)" }}
      >
        <CheckIcon />
      </motion.div>

      <h2
        id="waitlist-title"
        className="mt-4 text-2xl font-semibold tracking-[-0.01em] text-fg"
      >
        You&rsquo;re on the list
      </h2>
      <p className="mx-auto mt-2 max-w-[22rem] text-sm text-fg-soft">
        We saved <span className="text-fg">{email}</span>. We&rsquo;ll email you
        the moment your key is ready.
      </p>
      <button
        type="button"
        onClick={onClose}
        className="focusable mt-5 inline-flex h-10 cursor-pointer items-center justify-center rounded-md border border-line-strong bg-surface px-5 text-sm font-medium text-fg transition-colors hover:bg-surface-2"
      >
        Done
      </button>
    </div>
  );
}

function CloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M6 6l12 12M18 6L6 18"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <motion.path
        d="M5 12.5l4.5 4.5L19 7"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.4, delay: 0.1, ease: "easeOut" }}
      />
    </svg>
  );
}

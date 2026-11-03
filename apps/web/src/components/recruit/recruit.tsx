"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useRef, useState, useTransition, type CSSProperties, type FormEvent, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { DEEP_SCAN_TIERS, PR_REVIEW_TIERS } from "@sandchest/billing/costs";
import { taxIdFor } from "@sandchest/billing/tax-ids";
import { CREDIT_AMOUNTS, creditsDiscount, creditsPrice, creditsSaving, DEFAULT_CREDITS, PLAN, planById, TOP_UP_BELOW } from "@sandchest/billing/plans";
import { linesLabel, restCredits, type Briefing, type RecruitAccount } from "@/lib/briefing";
import {
  aside,
  DEFAULT_HACKER,
  HANDLE_MAX,
  HOODIES,
  looksDefault,
  MAX_STICKERS,
  PHOSPHORS,
  rollHandle,
  ROOMS,
  SHELLS,
  STICKERS,
  validHandle,
  VOICES,
  type Choice,
  type HackerProfile,
} from "@/lib/hacker";
import { loadFonts, pageFonts, stickerDataUrl } from "@/components/rig/art";
import { recruitPainter, type RecruitModel, type RecruitStep } from "@/components/rig/paint-recruit";
import { RigView } from "@/components/rig/rig-view";
import type { Painter } from "@/components/rig/screen";
import type { ShotName } from "@/components/rig/shots";
import { newSignals } from "@/components/rig/signals";
import { checkDiscount, completePayment, loadBriefing, preparePayment, recruit, saveInvoiceDetails, type DiscountCheck, type RecruitInput, type RecruitOrder, type RecruitOutcome } from "@/server/recruit-actions";
import type { LiveStats } from "@/server/stats";
import { CardForm, type CardHandle } from "./card-form";
import { LiveLines } from "./live-lines";

type StepId = "connect" | "company" | "hacker" | "plan" | "pay";

/** Each step's name in the progress bar, and where the camera stands for it. */
const STEP_INFO: Record<StepId, { name: string; shot: ShotName }> = {
  connect: { name: "GitHub", shot: "preview" },
  company: { name: "Company", shot: "preview" },
  hacker: { name: "Hacker", shot: "preview" },
  plan: { name: "Credits", shot: "preview" },
  pay: { name: "Pay", shot: "preview" },
};

/** What can be customized, in order, and what the camera turns to for each. */
const LOOKS = [
  { id: "hoodie", name: "Hoodie", shot: "hood" },
  { id: "shell", name: "Laptop", shot: "rig" },
  { id: "stickers", name: "Stickers", shot: "rig" },
  { id: "phosphor", name: "Screen", shot: "screen" },
  { id: "room", name: "Room", shot: "wide" },
  { id: "voice", name: "Voice", shot: "preview" },
] as const satisfies readonly { id: string; name: string; shot: ShotName }[];

/** How long the pointer rests on a line of the look menu before the camera turns to it. */
const LOOK_DWELL_MS = 220;

/** How far right the picture sits on the Hacker step, to leave the left side for the panel. */
const SHIFT = 0.17;
/** How far left it sits on the other steps, so the hacker shows beside the centred panel rather than behind it. */
const CENTRED_SHIFT = -0.3;
/** How long the panel stays hidden while it changes place. */
const PANEL_CUT_MS = 120;

/**
 * How lit the room is behind each step, on wide screens. The panel sits over the middle of it, so it dims
 * (in dither, to scattered dots) everywhere but the Hacker step, where the panel steps aside to show them.
 */
const ROOM_LIGHT: Record<StepId, number> = { connect: 0.55, company: 0.55, hacker: 1.15, plan: 0.55, pay: 0.25 };

/** The brand's gold, for the card form's focus rings: the page is lit in gold, only the room in the screen's colour. */
const GOLD = "#fec242";
/** Repositories listed before "Show all". */
const REPOS_SHOWN = 8;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface Props {
  accounts: RecruitAccount[];
  initial: Briefing | null;
  startAt: "connect" | "company";
  /** The person's GitHub login, for the screen. */
  viewer: string;
  installUrl: string | null;
  billing: boolean;
  /** Set when the card for joining is taken on this page. */
  publishableKey: string | null;
  stats: LiveStats | null;
  /** The dev preview: no server, so the card form is a stand-in and paying only plays the signing. */
  demo?: boolean;
}

type Opened = { clientSecret: string; publishableKey: string };
/** The card form: not opened yet, opening, open, charging, or unavailable (then Stripe Checkout takes the card). */
type Payment = { state: "idle" | "opening" | "failed" } | ({ state: "ready" | "paying" } & Opened);

/** "$26.00" */
const usd = (amount: number) => `$${amount.toFixed(2)}`;

/**
 * Setting up Sandchest like a game's character creation. The hacker's room
 * fills the screen; one panel down its dark left side holds the step you're
 * on, with the way forward always at the panel's foot. Connect GitHub, say
 * who the company is and where to look first, make the hacker, choose the
 * credits to start with, pay. Enter goes on, Esc goes back, and the camera
 * follows along.
 */
export function Recruit({ accounts, initial, startAt, viewer, installUrl, billing, publishableKey, stats, demo = false }: Props) {
  const router = useRouter();
  const [brief, setBrief] = useState<Briefing | null>(initial);
  const [switching, startSwitch] = useTransition();
  const [profile, setProfile] = useState<HackerProfile>(() => initial?.hacker ?? { ...DEFAULT_HACKER, handle: rollHandle() });
  // The room opens on a still of its first frame, where there is one for this hacker's look.
  const [still] = useState(() => (looksDefault(profile) ? ("onboard" as const) : undefined));
  const [company, setCompany] = useState(initial?.company ?? { name: "", email: "" });
  const [target, setTarget] = useState<string | null>(initial?.firstTarget ?? null);
  const [credits, setCredits] = useState<number>(DEFAULT_CREDITS);
  const [autoTopUp, setAutoTopUp] = useState(true);
  // Business invoices: a name and address from Stripe's Address Element, and a tax ID typed here.
  const [business, setBusiness] = useState(false);
  const [taxId, setTaxId] = useState("");
  const [taxCountry, setTaxCountry] = useState<string | null>(null);
  // A promotion code, checked against this purchase. A different amount of credits needs it checked again.
  const [discount, setDiscount] = useState<Extract<DiscountCheck, { code: string }> | null>(null);
  const [discountFor, setDiscountFor] = useState(credits);
  if (discountFor !== credits) {
    setDiscountFor(credits);
    setDiscount(null);
  }
  const applyDiscount = async (code: string): Promise<string | null> => {
    if (demo) {
      // The dev preview has no billing: DEMO20 takes 20% off, anything else is refused.
      if (code.trim().toUpperCase() !== "DEMO20") return "That code isn’t valid, or has expired.";
      const full = PLAN.price + creditsPrice(credits);
      setDiscount({ code: "DEMO20", discount: Math.round(full * 20) / 100, dueToday: Math.round(full * 80) / 100 });
      return null;
    }
    if (!brief) return "Codes can’t be checked right now. Try again in a minute.";
    const checked = await checkDiscount(brief.orgId, code, order);
    if ("error" in checked) return checked.error;
    setDiscount(checked);
    return null;
  };
  const [look, setLook] = useState(-1);
  const [payment, setPayment] = useState<Payment>({ state: "idle" });
  const [payError, setPayError] = useState<string | null>(null);
  const [signed, setSigned] = useState(false);
  const [state, action, pending] = useActionState<RecruitOutcome, FormData>((previous, data) => recruit(brief?.orgId ?? "", previous, data), {});
  const card = useRef<CardHandle>(null);
  const form = useRef<HTMLFormElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const signals = useRef(newSignals());
  const wide = useWide();

  const payOnPage = billing && !!publishableKey && !brief?.currentPlan && payment.state !== "failed";
  // Paying on this page is a step of its own, in the same panel as every other, so nothing moves when it opens.
  const steps: StepId[] = payOnPage ? ["connect", "company", "hacker", "plan", "pay"] : ["connect", "company", "hacker", "plan"];
  const [step, setStep] = useState(() => (startAt === "company" && initial ? 1 : 0));
  const current = steps[Math.min(step, steps.length - 1)]!;
  const org = brief?.login ?? accounts[0]?.login ?? viewer;
  const name = profile.handle.trim() || "your hacker";
  const handleOk = validHandle(profile.handle);
  const companyOk = company.name.trim().length > 0 && (EMAIL.test(company.email.trim()) || (!billing && company.email.trim() === ""));
  const busy = pending || payment.state === "paying" || signed;
  const checkout = current === "pay";
  /** The Hacker step: the panel moves to the side so the hacker can be seen. */
  const panelAside = current === "hacker";
  // The panel doesn't travel there: it cuts out, and fades back in at its new place, with the picture already
  // reframed behind it. One clean change instead of several things moving at once.
  const [placed, setPlaced] = useState(panelAside);
  useEffect(() => {
    if (placed === panelAside) return;
    const swap = setTimeout(() => setPlaced(panelAside), PANEL_CUT_MS);
    return () => clearTimeout(swap);
  }, [panelAside, placed]);
  const moving = placed !== panelAside;

  /** Whether a step is finished, so the ones after it can be entered. */
  const done = (id: StepId) => (id === "connect" ? !!brief : id === "company" ? companyOk : id === "hacker" ? handleOk : true);
  const canEnter = (i: number) => steps.slice(0, i).every(done);

  const screen: RecruitStep = signed || pending ? "signing" : current === "hacker" && look >= 0 ? "customize" : current;
  const shot: ShotName = signed || pending ? "screen" : current === "hacker" && look >= 0 ? LOOKS[look]!.shot : STEP_INFO[current].shot;
  const now: RecruitModel = {
    step: screen,
    profile,
    viewer,
    accounts: accounts.map((a) => a.login),
    repos: brief?.repos ?? [],
    target,
    org,
    credits,
    autoTopUp,
    currentPlan: brief?.currentPlan ?? null,
    billing,
  };
  const model = useRef<RecruitModel>(now);
  useEffect(() => {
    model.current = now;
  });
  const [paint] = useState<{ current: Painter | null }>(() => ({ current: recruitPainter(model) }));

  const nudge = (seconds: number) => {
    signals.current.typingUntil = signals.current.now + seconds;
  };
  const update = (patch: Partial<HackerProfile>) => {
    setProfile((p) => ({ ...p, ...patch }));
    nudge(0.5);
  };
  const go = (to: number) => {
    const next = Math.max(0, Math.min(steps.length - 1, to));
    if (!canEnter(next) || busy) return;
    setStep(next);
    setLook(-1);
    setPayError(null);
    nudge(0.8);
  };

  /** Choosing an account: its briefing, the look its hacker already has, and its URL. */
  const choose = (account: RecruitAccount) => {
    if (account.id === brief?.orgId) return;
    startSwitch(async () => {
      const next = await loadBriefing(account.id);
      if (!next) return;
      setBrief(next);
      setCompany(next.company);
      setTarget(next.firstTarget);
      if (next.hacker) setProfile(next.hacker);
      setPayment({ state: "idle" });
      history.replaceState(null, "", `/dashboard/recruit?org=${next.orgId}`);
      nudge(1);
    });
  };

  const recruitment = (): RecruitInput => ({ hacker: profile, company: { name: company.name.trim(), email: company.email.trim() }, firstTarget: target });
  const order: RecruitOrder = { credits, autoTopUp };

  // A new step moves focus to its heading, so keyboard and screen reader users start at its top.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    heading.current?.focus();
  }, [step]);

  // Enter goes on from anywhere that isn't a control of its own. It never pays: that takes the Pay button.
  const paying = useRef(false);
  paying.current = checkout;
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Enter" || paying.current || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const at = document.activeElement;
      if (!at || at === document.body || at === heading.current) {
        event.preventDefault();
        form.current?.requestSubmit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The arrows choose from anywhere on a step, not only once a choice has focus (a new step focuses its heading):
  // they move the step's list on by one, as they would on the list itself. The Hacker menu has its own.
  const on = useRef(current);
  on.current = current;
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (on.current === "hacker" || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const back = event.key === "ArrowUp" || event.key === "ArrowLeft";
      if (!back && event.key !== "ArrowDown" && event.key !== "ArrowRight") return;
      const at = document.activeElement;
      if (at instanceof HTMLInputElement || at instanceof HTMLTextAreaElement || at instanceof HTMLSelectElement) return;
      const body = form.current?.querySelector(".onboard-body");
      const set = (at instanceof HTMLElement && at.closest("fieldset")) || body?.querySelector('fieldset:has(input[type="radio"])');
      const choices = [...(set?.querySelectorAll<HTMLInputElement>('input[type="radio"]:not(:disabled)') ?? [])];
      if (choices.length === 0) return;
      event.preventDefault();
      const from = choices.findIndex((c) => c.checked);
      const next = choices[from < 0 ? 0 : (from + (back ? -1 : 1) + choices.length) % choices.length]!;
      if (!next.checked) next.click();
      next.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    const at = event.target as HTMLElement;
    if (event.key === "Escape" && !busy && step > 0) {
      event.preventDefault();
      go(step - 1);
    } else if (event.key === "Enter" && !checkout && at instanceof HTMLInputElement && (at.type === "radio" || at.type === "checkbox")) {
      // Enter on a choice means "this one, and on".
      event.preventDefault();
      form.current?.requestSubmit();
    }
  };

  // The card form starts opening on the credits step, so it's ready by the time they reach Pay. A card is saved
  // for later charges, so it doesn't depend on how many credits are picked. If it can't open, Stripe Checkout
  // takes the card instead.
  const opening = useRef(false);
  useEffect(() => {
    if ((current !== "plan" && current !== "pay") || !brief || !billing || !publishableKey || brief.currentPlan || payment.state !== "idle" || opening.current) return;
    if (demo) return setPayment({ state: "ready", clientSecret: "", publishableKey: "" });
    opening.current = true;
    setPayment({ state: "opening" });
    void preparePayment(brief.orgId, recruitment()).then((opened) => {
      opening.current = false;
      setPayment("error" in opened ? { state: "failed" } : { state: "ready", ...opened });
    });
  });

  const pay = async () => {
    if (demo) {
      setSigned(true);
      setTimeout(() => setSigned(false), 4_000);
      return;
    }
    if (!brief || payment.state !== "ready" || !card.current) return;
    const opened = { clientSecret: payment.clientSecret, publishableKey: payment.publishableKey };
    setPayError(null);
    setPayment({ state: "paying", ...opened });
    nudge(3);
    // The business's details go on the Stripe customer before the card is saved, so a tax ID Stripe rejects
    // stops here, with nothing charged, and the first invoice carries them.
    if (business) {
      const address = await card.current.business();
      const kind = taxIdFor(address && !("error" in address) ? address.address.country : null);
      const invoice =
        !address || "error" in address
          ? (address ?? { error: "The business details aren’t ready yet." })
          : await saveInvoiceDetails(brief.orgId, { ...address, taxId: kind && taxId.trim() ? { type: kind.type, value: taxId.trim() } : null });
      if (invoice.error) {
        setPayment({ state: "ready", ...opened });
        setPayError(invoice.error);
        return;
      }
    }
    const saved = await card.current.confirm();
    const outcome = "error" in saved ? saved : await completePayment(brief.orgId, order, saved.setupIntentId, recruitment(), discount?.code);
    if ("error" in outcome) {
      setPayment({ state: "ready", ...opened });
      setPayError(outcome.error);
      return;
    }
    // The contract signs itself on screen, then it's off to work.
    setSigned(true);
    setTimeout(() => (outcome.next.startsWith("/") ? router.push(outcome.next) : window.location.assign(outcome.next)), 1_600);
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    if (busy) return event.preventDefault();
    if (current === "plan" && !payOnPage) {
      // The last step without a card form: the server saves it all and joins the plan (on Stripe Checkout).
      nudge(3);
      return;
    }
    event.preventDefault();
    if (current === "connect" && !brief && installUrl) window.location.assign(installUrl);
    else if (current === "pay") void pay();
    else go(step + 1);
  };

  const total = discount?.dueToday ?? PLAN.price + creditsPrice(credits);
  const forward = (() => {
    if (pending) return "One moment…";
    if (current === "connect") return brief ? `Continue as ${brief.login}` : accounts.length === 0 ? "Connect GitHub" : "Choose an account";
    if (current === "company") return "Continue";
    if (current === "hacker") return `Recruit ${name}`;
    if (current === "plan") {
      if (!billing) return `Add ${name} to ${org}`;
      if (brief?.currentPlan) return "Save";
      if (!payOnPage) return `Pay ${usd(total)} on Stripe`;
      return "Continue to payment";
    }
    if (current === "pay") {
      if (signed) return "Paid";
      if (payment.state === "paying") return "Paying…";
      return `Pay ${usd(total)}`;
    }
    return "Continue";
  })();
  const forwardOk = current === "connect" ? !!brief || (accounts.length === 0 && !!installUrl) : checkout ? payment.state === "ready" : done(current);

  return (
    <div className="onboard">
      <RigView
        className="onboard-scene"
        profile={profile}
        org={org}
        shot={shot}
        paint={paint}
        signals={signals}
        frameShift={wide ? (placed ? SHIFT : CENTRED_SHIFT) : 0}
        // Once paid, the room comes back up for the contract signing itself on screen.
        light={!wide || signed || pending ? 1 : ROOM_LIGHT[current]}
        opening={still}
        poster
      />
      <div className="onboard-shade" aria-hidden="true" />

      <header className="onboard-top">
        <Link href="/dashboard?later=1" className="onboard-mark" aria-label="Sandchest dashboard">
          <img src="/sandchest-logo-dark.svg" alt="" width={120} height={22} />
        </Link>
        <Progress steps={steps} step={step} canEnter={canEnter} go={go} />
        <Link href="/dashboard?later=1" className="onboard-leave">
          {brief?.hacker ? "Back to the dashboard" : "Finish later"}
        </Link>
      </header>

      <form ref={form} action={action} className="onboard-hud" onKeyDown={onKeyDown} onSubmit={onSubmit}>
        <input type="hidden" name="recruitment" value={JSON.stringify(recruitment())} />
        {billing && <input type="hidden" name="order" value={JSON.stringify(order)} />}

        <section className="onboard-panel" data-aside={placed || undefined} data-moving={moving || undefined} aria-labelledby="onboard-title">
          <div className="onboard-body" key={current}>
            {current === "connect" && <Connect heading={heading} accounts={accounts} chosen={brief?.orgId ?? null} switching={switching} choose={choose} installUrl={installUrl} />}
            {current === "company" && brief && (
              <Company heading={heading} brief={brief} company={company} setCompany={setCompany} target={target} setTarget={setTarget} billing={billing} nudge={nudge} />
            )}
            {current === "hacker" && <Hacker heading={heading} profile={profile} update={update} look={look} setLook={setLook} />}
            {current === "plan" && (
              <Credits
                heading={heading}
                brief={brief}
                billing={billing}
                name={name}
                org={org}
                target={target}
                credits={credits}
                setCredits={setCredits}
                autoTopUp={autoTopUp}
                setAutoTopUp={setAutoTopUp}
              />
            )}
            {current === "pay" && (
              <Pay
                heading={heading}
                brief={brief}
                org={org}
                credits={credits}
                autoTopUp={autoTopUp}
                setAutoTopUp={setAutoTopUp}
                business={business}
                setBusiness={setBusiness}
                taxId={taxId}
                setTaxId={setTaxId}
                taxCountry={taxCountry}
                setTaxCountry={setTaxCountry}
                discount={discount}
                applyDiscount={applyDiscount}
                removeDiscount={() => setDiscount(null)}
                payment={payment}
                card={card}
                onError={setPayError}
                demo={demo}
                accent={GOLD}
              />
            )}
            {(state.error || payError) && (
              <p className="onboard-error" role="alert">
                {payError ?? state.error}
              </p>
            )}
          </div>

          <footer className="onboard-foot">
            {step > 0 && (
              <button type="button" className="onboard-back" onClick={() => go(step - 1)} disabled={busy}>
                <span className="onboard-face">
                  <Key>Esc</Key>
                  Back
                </span>
              </button>
            )}
            <button type="submit" className="onboard-go" disabled={!forwardOk || busy}>
              <span className="onboard-face">
                <span className="onboard-go-label">{forward}</span>
                {/* Enter never pays: that takes a click on the button itself. */}
                {!checkout && <Key>Enter</Key>}
              </span>
            </button>
          </footer>
        </section>
      </form>

      {/* The running count fills the empty side of the room while the panel is centred, and steps away when it moves aside. */}
      {stats && <LiveLines initial={stats} hidden={!wide || placed || moving} />}
      <Hints current={current} />
    </div>
  );
}

/** Wide enough for the picture and the panel side by side. */
function useWide(): boolean {
  const [wide, setWide] = useState(true);
  useEffect(() => {
    const query = matchMedia("(min-width: 861px)");
    setWide(query.matches);
    const change = () => setWide(query.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  return wide;
}

/** The steps as a game's progress bar: done ones ticked, the current one lit, later ones dim. */
function Progress({ steps, step, canEnter, go }: { steps: StepId[]; step: number; canEnter: (i: number) => boolean; go: (i: number) => void }) {
  return (
    <nav aria-label="Setup steps">
      <ol className="onboard-steps">
        {steps.map((id, i) => {
          const state = i < step ? "done" : i === step ? "current" : "next";
          return (
            <li key={id} data-state={state}>
              <button type="button" onClick={() => go(i)} disabled={i === step || !canEnter(i)} aria-current={state === "current" ? "step" : undefined}>
                <span className="onboard-step-mark" aria-hidden="true">
                  {state === "done" ? <Check /> : i + 1}
                </span>
                <span className="onboard-step-name">
                  {STEP_INFO[id].name}
                  {state === "done" && <span className="sr-only">, done</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** The keys that work on this step, besides Enter and Esc (which are on the buttons). Hidden on touch screens. */
function Hints({ current }: { current: StepId }) {
  const hints: [string, string][] =
    current === "hacker"
      ? [
          ["↑↓", "Choose"],
          ["←→", "Change"],
        ]
      : current === "plan"
        ? [["←→", "Choose"]]
        : current === "pay"
          ? []
          : [["↑↓", "Choose"]];
  if (hints.length === 0) return null;
  return (
    <ul className="onboard-hints" aria-hidden="true">
      {hints.map(([key, what]) => (
        <li key={what}>
          <Key>{key}</Key> {what}
        </li>
      ))}
    </ul>
  );
}

function Key({ children }: { children: ReactNode }) {
  return <kbd className="onboard-key">{children}</kbd>;
}

function Title({ heading, children }: { heading: RefObject<HTMLHeadingElement | null>; children: ReactNode }) {
  return (
    <h1 className="onboard-title" id="onboard-title" ref={heading} tabIndex={-1}>
      {children}
    </h1>
  );
}

// ---- Steps ---------------------------------------------------------------------

function Connect({
  heading,
  accounts,
  chosen,
  switching,
  choose,
  installUrl,
}: {
  heading: RefObject<HTMLHeadingElement | null>;
  accounts: RecruitAccount[];
  chosen: string | null;
  switching: boolean;
  choose: (account: RecruitAccount) => void;
  installUrl: string | null;
}) {
  return (
    <>
      <Title heading={heading}>Connect GitHub</Title>
      <p className="onboard-lead">Your hacker works from GitHub. You choose the repositories it may read; it reviews their pull requests and scans their code, and never pushes a line.</p>
      {accounts.length > 0 ? (
        <fieldset className="onboard-set" aria-busy={switching || undefined}>
          <legend className="onboard-label">Account</legend>
          <ul className="onboard-menu">
            {accounts.map((account) => (
              <li key={account.id}>
                <label className="onboard-option onboard-account" data-on={chosen === account.id || undefined}>
                  <input type="radio" name="account" checked={chosen === account.id} onChange={() => choose(account)} />
                  <img src={`https://github.com/${encodeURIComponent(account.login)}.png?size=80`} alt="" width={36} height={36} />
                  <span className="onboard-option-name">{account.login}</span>
                  <span className="onboard-option-note">
                    {account.type === "Organization" ? "Organization" : "Personal account"}
                    {account.handle ? `, ${account.handle} works here` : account.planId ? ", has a plan" : ""}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      ) : (
        <p className="onboard-note">GitHub asks which account and which repositories, then sends you straight back here.</p>
      )}
      {accounts.length > 0 && installUrl && (
        <a className="onboard-link" href={installUrl}>
          <GitHubMark /> Connect another account
        </a>
      )}
    </>
  );
}

function Company({
  heading,
  brief,
  company,
  setCompany,
  target,
  setTarget,
  billing,
  nudge,
}: {
  heading: RefObject<HTMLHeadingElement | null>;
  brief: Briefing;
  company: { name: string; email: string };
  setCompany: (company: { name: string; email: string }) => void;
  target: string | null;
  setTarget: (id: string) => void;
  billing: boolean;
  nudge: (seconds: number) => void;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? brief.repos : brief.repos.slice(0, REPOS_SHOWN);
  const { profile } = brief;
  return (
    <>
      <Title heading={heading}>Your company</Title>
      <div className="onboard-card">
        <img src={profile.avatar} alt="" width={52} height={52} />
        <div>
          <p className="onboard-card-name">{profile.name}</p>
          <p className="onboard-card-login">github.com/{brief.login}</p>
          {profile.about && <p className="onboard-card-about">{profile.about}</p>}
          {(profile.website || profile.location) && (
            <p className="onboard-card-meta">
              {profile.website && <span>{profile.website.replace(/^https?:\/\//, "").replace(/\/$/, "")}</span>}
              {profile.location && <span>{profile.location}</span>}
            </p>
          )}
        </div>
      </div>

      <div className="onboard-fields">
        <label className="onboard-field">
          <span className="onboard-label">Company name</span>
          <input value={company.name} maxLength={120} autoComplete="organization" required onChange={(event) => setCompany({ ...company, name: event.target.value })} />
        </label>
        <label className="onboard-field">
          <span className="onboard-label">Billing email</span>
          <input
            type="email"
            value={company.email}
            maxLength={254}
            autoComplete="email"
            required={billing}
            placeholder="you@company.com"
            onChange={(event) => setCompany({ ...company, email: event.target.value })}
          />
        </label>
      </div>

      <fieldset className="onboard-set">
        <legend className="onboard-label">Where to look first</legend>
        {brief.repos.length === 0 ? (
          <p className="onboard-note">No repositories yet. Add some to the installation on GitHub and they’ll show here.</p>
        ) : (
          <>
            <ul className="onboard-menu onboard-repos">
              {shown.map((repo) => {
                const [owner, repoName] = repo.fullName.split("/");
                return (
                  <li key={repo.id}>
                    <label className="onboard-option onboard-repo" data-on={target === repo.id || undefined}>
                      <input
                        type="radio"
                        name="target"
                        checked={target === repo.id}
                        onChange={() => {
                          setTarget(repo.id);
                          nudge(0.8);
                        }}
                      />
                      <span className="onboard-option-name">
                        <span className="onboard-dim">{owner}/</span>
                        {repoName}
                      </span>
                      <span className="onboard-option-note">{[repo.language, linesLabel(repo.loc), repo.private ? "private" : "public"].filter(Boolean).join(", ")}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
            {brief.repos.length > REPOS_SHOWN && !all && (
              <button type="button" className="onboard-link" onClick={() => setAll(true)}>
                Show all {brief.repos.length}
              </button>
            )}
            <p className="onboard-help">{billing ? "Your hacker scans this one as soon as you’ve paid. The first deep scan is free." : "Your hacker scans this one first."}</p>
          </>
        )}
      </fieldset>
    </>
  );
}

/**
 * The hacker: a name, then everything about how they look and talk as a
 * game menu, one line per thing. ↑↓ move between lines, ←→ or the arrows
 * change the value, and the camera turns to what the line changes.
 */
function Hacker({
  heading,
  profile,
  update,
  look,
  setLook,
}: {
  heading: RefObject<HTMLHeadingElement | null>;
  profile: HackerProfile;
  update: (patch: Partial<HackerProfile>) => void;
  look: number;
  setLook: (at: number) => void;
}) {
  const handleOk = validHandle(profile.handle);
  const menu = useRef<HTMLDivElement>(null);
  const name = useRef<HTMLInputElement>(null);
  // The lit line, read by the window's key listener as well as here.
  const lit = useRef(look);
  lit.current = look;
  const move = (by: number) => {
    const rows = [...(menu.current?.querySelectorAll<HTMLElement>("[data-look]") ?? [])];
    const from = rows.findIndex((r) => r.contains(document.activeElement));
    const to = (from < 0 ? lit.current : from) + by;
    if (to < 0) return name.current?.focus();
    const row = rows[Math.min(rows.length - 1, to)];
    (row?.querySelector<HTMLInputElement>("input:checked") ?? row?.querySelector<HTMLInputElement>("input:not(:disabled)"))?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      move(event.key === "ArrowUp" ? -1 : 1);
    }
  };
  // The arrows work from anywhere on the step, not only once a line has focus: ↑↓ pick a line, ←→ change the
  // one that's lit (by focus or by the pointer). Inside the name field and on a choice, the field answers.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const vertical = event.key === "ArrowUp" || event.key === "ArrowDown";
      if (!vertical && event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const at = document.activeElement;
      if (at instanceof HTMLInputElement || at instanceof HTMLTextAreaElement || at instanceof HTMLSelectElement) return;
      event.preventDefault();
      if (vertical) return move(event.key === "ArrowUp" ? -1 : 1);
      const rows = [...(menu.current?.querySelectorAll<HTMLElement>("[data-look]") ?? [])];
      const row = rows.find((r) => r.contains(at)) ?? rows[Math.max(0, lit.current)];
      const choices = [...(row?.querySelectorAll<HTMLInputElement>("input:not(:disabled)") ?? [])];
      if (choices.length === 0) return;
      if (choices[0]!.type === "checkbox") return choices[event.key === "ArrowLeft" ? choices.length - 1 : 0]!.focus();
      const from = Math.max(0, choices.findIndex((c) => c.checked));
      const next = choices[(from + (event.key === "ArrowLeft" ? -1 : 1) + choices.length) % choices.length]!;
      next.click();
      next.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // move reads the menu and the lit line through refs, so the first one is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // The pointer has to rest on a line before the camera turns to it, so sweeping across the menu doesn't
  // send the camera around the room after every line it crosses. Focus turns it at once.
  const dwell = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(dwell.current), []);
  const row = (at: number) => ({
    "data-look": LOOKS[at]!.id,
    "data-on": look === at || undefined,
    onFocus: () => {
      clearTimeout(dwell.current);
      setLook(at);
    },
    onPointerEnter: () => {
      clearTimeout(dwell.current);
      dwell.current = setTimeout(() => setLook(at), LOOK_DWELL_MS);
    },
    onPointerLeave: () => clearTimeout(dwell.current),
  });
  const voices = VOICES.map((v) => ({ ...v, note: `“${aside(v.id, "finding", 1)}”` }));
  return (
    <>
      <Title heading={heading}>Your hacker</Title>
      <label className="onboard-label onboard-name-label" htmlFor="onboard-handle">
        Name
      </label>
      <div className="onboard-name">
        <input
          id="onboard-handle"
          ref={name}
          value={profile.handle}
          onChange={(event) => update({ handle: event.target.value.slice(0, HANDLE_MAX) })}
          onFocus={() => setLook(-1)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              move(1);
            }
          }}
          maxLength={HANDLE_MAX}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={!handleOk || undefined}
          aria-describedby="handle-help"
        />
        <button type="button" onClick={() => update({ handle: rollHandle(profile.handle) })}>
          <Dice /> Roll
        </button>
      </div>
      <p id="handle-help" className={handleOk ? "onboard-help" : "onboard-help onboard-bad"}>
        {handleOk ? "The name on their scans and reviews." : "Start with a letter or number, and keep it to 16 characters."}
      </p>

      <div className="onboard-looks" ref={menu} onKeyDown={onKeyDown} role="group" aria-label="Look">
        <Cycle {...row(0)} legend="Hoodie" group="hoodie" items={HOODIES} value={profile.hoodie} onChange={(hoodie) => update({ hoodie })} />
        <Cycle {...row(1)} legend="Laptop" group="shell" items={SHELLS} value={profile.shell} onChange={(shell) => update({ shell })} />
        <Stickers {...row(2)} value={profile.stickers} onChange={(stickers) => update({ stickers })} />
        <Cycle {...row(3)} legend="Screen" group="phosphor" items={PHOSPHORS} value={profile.phosphor} onChange={(phosphor) => update({ phosphor })} />
        <Cycle {...row(4)} legend="Room" group="room" items={ROOMS} value={profile.room} onChange={(room) => update({ room })} />
        <Cycle {...row(5)} legend="Voice" group="voice" items={voices} value={profile.voice} onChange={(voice) => update({ voice })} />
      </div>
      {/* The lit line's description, in one place with its height kept, so lighting a line never moves the menu. */}
      <p className="onboard-look-detail" aria-hidden="true">
        {look === 1 ? SHELLS.find((s) => s.id === profile.shell)?.note : look === 4 ? ROOMS.find((r) => r.id === profile.room)?.note : look === 5 ? voices.find((v) => v.id === profile.voice)?.note : null}
      </p>
    </>
  );
}

function Credits({
  heading,
  brief,
  billing,
  name,
  org,
  target,
  credits,
  setCredits,
  autoTopUp,
  setAutoTopUp,
}: {
  heading: RefObject<HTMLHeadingElement | null>;
  brief: Briefing | null;
  billing: boolean;
  name: string;
  org: string;
  target: string | null;
  credits: number;
  setCredits: (credits: number) => void;
  autoTopUp: boolean;
  setAutoTopUp: (on: boolean) => void;
}) {
  if (!billing) {
    return (
      <>
        <Title heading={heading}>You’re ready</Title>
        <p className="onboard-lead">
          This server runs without billing, so there’s nothing to pay. {name} starts mapping {org}’s repositories as soon as you finish.
        </p>
      </>
    );
  }
  if (brief?.currentPlan) {
    return (
      <>
        <Title heading={heading}>You’re ready</Title>
        <p className="onboard-lead">
          {org} is already on {planById(brief.currentPlan)?.name ?? "a plan"}, so there’s nothing to pay. Save, and {name} picks up {org}’s next pull request.
        </p>
      </>
    );
  }

  const repos = brief?.repos ?? [];
  const rest = restCredits(repos, target);
  const scans = DEEP_SCAN_TIERS.map((tier) => tier.credits);
  const picker = (
    <>
      <p className="onboard-lead">
        ${PLAN.price} a month, plus credits for the work. Credits never expire.
      </p>
      <dl className="onboard-rates">
        <div>
          <dt>Pull request review</dt>
          <dd>{PR_REVIEW_TIERS[0]!.credits} credit</dd>
        </div>
        <div>
          <dt>Deep scan</dt>
          <dd>
            {scans[0]}–{scans.at(-1)} credits
          </dd>
        </div>
        <div>
          <dt>First deep scan</dt>
          <dd>Free</dd>
        </div>
      </dl>
      <fieldset className="onboard-set">
        <legend className="onboard-label">Start with</legend>
        <div className="onboard-amounts">
          {CREDIT_AMOUNTS.map((amount) => (
            <label key={amount} className="onboard-amount" data-on={credits === amount || undefined}>
              <input type="radio" name="credits-pick" checked={credits === amount} onChange={() => setCredits(amount)} />
              <span className="onboard-amount-n">{amount}</span>
              <span className="onboard-amount-usd">{usd(creditsPrice(amount))}</span>
              {creditsSaving(amount) > 0 && <span className="onboard-amount-save">Save {usd(creditsSaving(amount))}</span>}
            </label>
          ))}
        </div>
        {rest.credits > 0 && (
          <p className="onboard-help">
            Deep scanning {org}’s {rest.repos < repos.length ? "other " : ""}
            {rest.repos === 1 ? "repository" : `${rest.repos} repositories`} takes {rest.credits} credits.
          </p>
        )}
      </fieldset>
      <label className="onboard-check">
        <input type="checkbox" checked={autoTopUp} onChange={(event) => setAutoTopUp(event.target.checked)} />
        <span>
          Auto top-up
          <span className="onboard-check-note">
            Adds {credits} credits for {usd(creditsPrice(credits))} when your balance falls below {TOP_UP_BELOW}.
          </span>
        </span>
      </label>
    </>
  );
  return (
    <>
      <Title heading={heading}>Add credits</Title>
      {picker}
    </>
  );
}

/**
 * Paying: what's charged today, line by line, Stripe's card fields, and what
 * happens after. The step keeps the panel and its title like every other, but
 * the bill is set in the system's sans, as on any checkout people trust.
 */
function Pay({
  heading,
  brief,
  org,
  credits,
  autoTopUp,
  setAutoTopUp,
  business,
  setBusiness,
  taxId,
  setTaxId,
  taxCountry,
  setTaxCountry,
  discount,
  applyDiscount,
  removeDiscount,
  payment,
  card,
  onError,
  demo,
  accent,
}: {
  heading: RefObject<HTMLHeadingElement | null>;
  brief: Briefing | null;
  org: string;
  credits: number;
  autoTopUp: boolean;
  setAutoTopUp: (on: boolean) => void;
  business: boolean;
  setBusiness: (on: boolean) => void;
  taxId: string;
  setTaxId: (value: string) => void;
  taxCountry: string | null;
  setTaxCountry: (country: string | null) => void;
  discount: Extract<DiscountCheck, { code: string }> | null;
  applyDiscount: (code: string) => Promise<string | null>;
  removeDiscount: () => void;
  payment: Payment;
  card: RefObject<CardHandle | null>;
  onError: (message: string) => void;
  demo: boolean;
  accent: string;
}) {
  const total = discount?.dueToday ?? PLAN.price + creditsPrice(credits);
  const company = brief?.company.name || org;
  const kind = taxIdFor(taxCountry);
  const taxField = business && kind && (
    <label className="onboard-bill-field">
      <span>
        {kind.label} <span className="onboard-bill-optional">optional</span>
      </span>
      <input value={taxId} onChange={(event) => setTaxId(event.target.value)} placeholder={kind.example} maxLength={64} autoComplete="off" spellCheck={false} />
    </label>
  );
  return (
    <>
      <Title heading={heading}>Pay</Title>
      <div className="onboard-bill">
        <dl className="onboard-bill-lines">
          <div>
            <dt>{PLAN.name} plan, monthly</dt>
            <dd>{usd(PLAN.price)}</dd>
          </div>
          <div>
            <dt>
              {credits} credits
              {creditsSaving(credits) > 0 && (
                <span className="onboard-bill-saving">
                  , {usd(creditsSaving(credits))} off ({creditsDiscount(credits)}%)
                </span>
              )}
            </dt>
            <dd>{usd(creditsPrice(credits))}</dd>
          </div>
          {discount && (
            <div className="onboard-bill-saving">
              <dt>
                Code {discount.code}{" "}
                <button type="button" className="onboard-bill-link" onClick={removeDiscount}>
                  Remove
                </button>
              </dt>
              <dd>−{usd(discount.discount)}</dd>
            </div>
          )}
          <div className="onboard-bill-total">
            <dt>Due today</dt>
            <dd>{usd(total)}</dd>
          </div>
        </dl>
        {!discount && <DiscountCode apply={applyDiscount} />}
        <label className="onboard-bill-toggle">
          <span>
            <span className="onboard-bill-toggle-name">Auto top-up</span>
            <span className="onboard-bill-toggle-note">
              Adds {credits} credits for {usd(creditsPrice(credits))} when your balance falls below {TOP_UP_BELOW}.
            </span>
          </span>
          <input type="checkbox" role="switch" checked={autoTopUp} onChange={(event) => setAutoTopUp(event.target.checked)} />
        </label>
        <label className="onboard-bill-toggle">
          <span className="onboard-bill-toggle-name">Add business details to invoices</span>
          <input type="checkbox" role="switch" checked={business} onChange={(event) => setBusiness(event.target.checked)} />
        </label>
        {demo ? (
          <>
            {business && <DemoBusiness name={company} onCountry={setTaxCountry} />}
            {taxField}
            <DemoCard address={!business} />
          </>
        ) : payment.state === "ready" || payment.state === "paying" ? (
          <CardForm
            ref={card}
            clientSecret={payment.clientSecret}
            publishableKey={payment.publishableKey}
            accent={accent}
            business={business}
            businessName={company}
            onCountry={setTaxCountry}
            between={taxField}
            onError={onError}
          />
        ) : (
          <div className="onboard-card-loading" aria-hidden="true" />
        )}
        <p className="onboard-bill-fine">
          Renews at {usd(PLAN.price)} a month. Cancel any time in Billing.
        </p>
        <p className="onboard-bill-secure">
          <Lock />
          <span>
            Processed by <strong>Stripe</strong>. Sandchest never sees your card.
          </span>
        </p>
      </div>
    </>
  );
}

/** "Have a discount code?": a link until it's wanted, then a field and Apply. */
function DiscountCode({ apply }: { apply: (code: string) => Promise<string | null> }) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) field.current?.focus();
  }, [open]);
  const submit = async () => {
    if (!code.trim() || checking) return;
    setChecking(true);
    setError(await apply(code));
    setChecking(false);
  };
  if (!open) {
    return (
      <p className="onboard-discount">
        <button type="button" className="onboard-bill-link" onClick={() => setOpen(true)}>
          Have a discount code?
        </button>
      </p>
    );
  }
  return (
    <div className="onboard-discount">
      <div className="onboard-discount-row">
        <input
          ref={field}
          value={code}
          onChange={(event) => {
            setCode(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            // Enter applies the code; it never pays.
            if (event.key === "Enter") {
              event.preventDefault();
              void submit();
            }
          }}
          placeholder="Discount code"
          aria-label="Discount code"
          aria-invalid={!!error || undefined}
          aria-describedby={error ? "discount-error" : undefined}
          maxLength={64}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
        />
        <button type="button" className="onboard-discount-apply" onClick={() => void submit()} disabled={!code.trim() || checking}>
          {checking ? "Checking…" : "Apply"}
        </button>
      </div>
      {error && (
        <p id="discount-error" className="onboard-discount-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** The dev preview's stand-in for Stripe's Address Element, as a business's billing address. */
function DemoBusiness({ name, onCountry }: { name: string; onCountry: (country: string | null) => void }) {
  useEffect(() => {
    onCountry("US");
    return () => onCountry(null);
  }, [onCountry]);
  return (
    <div className="onboard-demo-card" aria-label="Business address (preview)">
      <label>
        Business name
        <input defaultValue={name} />
      </label>
      <label>
        Country or region
        <select defaultValue="US" onChange={(event) => onCountry(event.target.value)}>
          <option value="US">United States</option>
          <option value="GB">United Kingdom</option>
          <option value="DE">Germany</option>
          <option value="AU">Australia</option>
        </select>
      </label>
      <label>
        Address
        <input placeholder="Street address" />
      </label>
      <div>
        <label>
          City
          <input />
        </label>
        <label>
          ZIP code
          <input placeholder="12345" />
        </label>
      </div>
    </div>
  );
}

/** The dev preview's stand-in for Stripe's card fields: the same shape, so the layout reads true. */
function DemoCard({ address }: { address: boolean }) {
  return (
    <div className="onboard-demo-card" aria-label="Card details (preview)">
      <label>
        Card number
        <input placeholder="1234 1234 1234 1234" inputMode="numeric" />
      </label>
      <div>
        <label>
          Expiration date
          <input placeholder="MM / YY" />
        </label>
        <label>
          Security code
          <input placeholder="CVC" />
        </label>
      </div>
      {/* With a business address above, Stripe takes the card's country and postcode from it. */}
      {address && (
        <div>
          <label>
            Country
            <input defaultValue="United States" />
          </label>
          <label>
            ZIP code
            <input placeholder="12345" />
          </label>
        </div>
      )}
    </div>
  );
}

// ---- Menu lines ------------------------------------------------------------------

type RowProps = { "data-look": string; "data-on": true | undefined; onFocus: () => void; onPointerEnter: () => void; onPointerLeave: () => void };

/**
 * One menu line: the name, ◀ the value ▶, and a pip for each choice. The
 * pips are the radio buttons, so ←→ (and clicking a pip) choose natively.
 */
function Cycle({
  legend,
  group,
  items,
  value,
  onChange,
  ...row
}: RowProps & { legend: string; group: string; items: readonly (Choice & { color?: string })[]; value: string; onChange: (id: string) => void }) {
  const at = Math.max(0, items.findIndex((item) => item.id === value));
  const chosen = items[at]!;
  const step = (by: number) => onChange(items[(at + by + items.length) % items.length]!.id);
  return (
    <fieldset className="onboard-look" {...row}>
      <legend className="onboard-look-name">{legend}</legend>
      <div className="onboard-cycle">
        <button type="button" tabIndex={-1} aria-hidden="true" className="onboard-arrow" onClick={() => step(-1)}>
          <Arrow left />
        </button>
        <span className="onboard-look-value" aria-hidden="true">
          {chosen.color && <span className="onboard-chip" style={{ background: chosen.color }} />}
          {chosen.label}
        </span>
        <button type="button" tabIndex={-1} aria-hidden="true" className="onboard-arrow" onClick={() => step(1)}>
          <Arrow />
        </button>
      </div>
      <div className="onboard-pips">
        {items.map((item) => (
          <label key={item.id} className="onboard-pip" data-on={item.id === value || undefined} title={item.label} style={item.color ? ({ "--swatch": item.color } as CSSProperties) : undefined}>
            <input type="radio" name={`look-${group}`} checked={item.id === value} onChange={() => onChange(item.id)} />
            <span className="sr-only">{item.note ? `${item.label}: ${item.note}` : item.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Stickers: up to four, so checkboxes in place of the arrows. ←→ move between them; space sticks one on. */
function Stickers({ value, onChange, ...row }: RowProps & { value: string[]; onChange: (ids: string[]) => void }) {
  const [art, setArt] = useState<Record<string, string>>({});
  useEffect(() => {
    let alive = true;
    const fonts = pageFonts();
    loadFonts(fonts)
      .then(() => Promise.all(STICKERS.map(async (s) => [s.id, await stickerDataUrl(s.id, fonts)] as const)))
      .then((pairs) => alive && setArt(Object.fromEntries(pairs)));
    return () => {
      alive = false;
    };
  }, []);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const boxes = [...event.currentTarget.querySelectorAll<HTMLInputElement>("input")];
    const at = boxes.indexOf(event.target as HTMLInputElement);
    if (at < 0) return;
    event.preventDefault();
    boxes[Math.max(0, Math.min(boxes.length - 1, at + (event.key === "ArrowLeft" ? -1 : 1)))]?.focus();
  };
  return (
    <fieldset className="onboard-look" {...row}>
      <legend className="onboard-look-name">Stickers</legend>
      <span className="onboard-look-value">{value.length === 0 ? "None" : `${value.length} of ${MAX_STICKERS}`}</span>
      <div className="onboard-stickers" onKeyDown={onKeyDown}>
        {STICKERS.map((sticker) => {
          const on = value.includes(sticker.id);
          const full = !on && value.length >= MAX_STICKERS;
          return (
            <label key={sticker.id} className="onboard-sticker" data-on={on || undefined} data-off={full || undefined} title={sticker.label}>
              <input type="checkbox" checked={on} disabled={full} onChange={() => onChange(on ? value.filter((v) => v !== sticker.id) : [...value, sticker.id])} />
              {art[sticker.id] ? <img src={art[sticker.id]} alt="" width={40} height={40} /> : <span className="onboard-sticker-blank" />}
              <span className="sr-only">{sticker.label}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

// ---- Pixel icons -----------------------------------------------------------------

function Arrow({ left }: { left?: boolean }) {
  return (
    <svg width="10" height="10" viewBox="0 0 5 5" aria-hidden="true" shapeRendering="crispEdges" style={left ? { transform: "scaleX(-1)" } : undefined}>
      <path fill="currentColor" d="M1 0h1v1H1zM2 1h1v1H2zM3 2h1v1H3zM2 3h1v1H2zM1 4h1v1H1z" />
    </svg>
  );
}

function Dice() {
  return (
    <svg width="14" height="14" viewBox="0 0 7 7" aria-hidden="true" shapeRendering="crispEdges">
      <path fill="currentColor" d="M0 0h7v7H0zM1 1v5h5V1zM2 2h1v1H2zM4 4h1v1H4zM3 3h1v1H3z" fillRule="evenodd" />
    </svg>
  );
}

function Check() {
  return (
    <svg width="12" height="12" viewBox="0 0 6 6" aria-hidden="true" shapeRendering="crispEdges">
      <path fill="currentColor" d="M5 0h1v2H5zM4 2h1v1H4zM3 3h1v1H3zM2 4h1v1H2zM1 3h1v1H1z" />
    </svg>
  );
}

/** A plain padlock, drawn smooth: it sits on the bill, not in the game. */
function Lock() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path fill="currentColor" d="M8 1a3.5 3.5 0 0 0-3.5 3.5V7H4a1.5 1.5 0 0 0-1.5 1.5v5A1.5 1.5 0 0 0 4 15h8a1.5 1.5 0 0 0 1.5-1.5v-5A1.5 1.5 0 0 0 12 7h-.5V4.5A3.5 3.5 0 0 0 8 1Zm2 6V4.5a2 2 0 1 0-4 0V7h4Z" fillRule="evenodd" />
    </svg>
  );
}

function GitHubMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path
        fill="currentColor"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"
      />
    </svg>
  );
}

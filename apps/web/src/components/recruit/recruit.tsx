"use client";
import Link from "next/link";
import { trackStep } from "@/components/analytics";
import { useRouter, useSearchParams } from "next/navigation";
import { useActionState, useEffect, useLayoutEffect, useRef, useState, useTransition, type CSSProperties, type FormEvent, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { DEEP_SCAN_TIERS, PR_REVIEW_TIERS } from "@sandchest/billing/costs";
import { taxIdFor } from "@sandchest/billing/tax-ids";
import { CREDIT_AMOUNTS, CREDIT_PRICE as PLAN_CREDIT_PRICE, creditsDiscount, creditsPrice, creditsSaving, creditsWorth, DEFAULT_CREDITS, DEFAULT_TOP_UP_LIMIT_USD, FREE_CREDITS, PLAN, planById, TOP_UP_BELOW } from "@sandchest/billing/plans";
import { digAllCredits, type Briefing, type RecruitAccount } from "@/lib/briefing";
import { creditCount, creditsText } from "@/lib/format";
import { perCredit } from "@/lib/pricing";
import { MANY_REPOS } from "@/lib/installation";
import { closedMessage, type ClaimIntent, type ClaimOffer } from "@/lib/free-credits";
import { draftKey, readDraft, type RecruitDraft, type RecruitStepId } from "@/lib/recruit-draft";
import { site } from "@/lib/site";
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
import { HandleField } from "@/components/hacker/handle-field";
import { LookMenu, LOOKS } from "@/components/hacker/look-menu";
import { recruitPainter, type RecruitModel, type RecruitStep } from "@/components/rig/paint-recruit";
import { RigView } from "@/components/rig/rig-view";
import type { Painter } from "@/components/rig/screen";
import type { ShotName } from "@/components/rig/shots";
import { newSignals } from "@/components/rig/signals";
import { checkDiscount, completePayment, loadBriefing, preparePayment, recruit, saveInvoiceDetails, type DiscountCheck, type RecruitInput, type RecruitOrder, type RecruitOutcome } from "@/server/recruit-actions";
import type { LiveStats } from "@/server/stats";
import { CardForm, type CardHandle } from "./card-form";
import { LiveLines } from "./live-lines";
import { AgentPromptButton } from "../agent-prompt-button";
import { PageSkeleton, useInSkeleton } from "@/components/app/skeleton";

type StepId = RecruitStepId;

/** Each step's name in the progress bar, and where the camera stands for it. */
const STEP_INFO: Record<StepId, { name: string; shot: ShotName }> = {
  connect: { name: "GitHub", shot: "preview" },
  company: { name: "Company", shot: "preview" },
  hacker: { name: "Hacker", shot: "preview" },
  plan: { name: "Credits", shot: "preview" },
  pay: { name: "Pay", shot: "preview" },
};

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
/** An image that loads nothing, for pictures in a loading state's sample. */
const BLANK = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";
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
  /**
   * Set for a visitor who hasn't signed in: the first step's way forward is signing in with GitHub, which
   * comes back to that step. Nothing after it opens before then.
   */
  signIn?: () => Promise<void>;
  /** Set when the person came to claim free credits: joining is then free, with no card, where the account can claim. */
  claim?: ClaimIntent | null;
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
export function Recruit({ accounts, initial, startAt, viewer, installUrl, billing, publishableKey, stats, demo = false, signIn, claim = null }: Props) {
  const router = useRouter();
  const [brief, setBrief] = useState<Briefing | null>(initial);
  const [switching, startSwitch] = useTransition();
  const [signingIn, startSignIn] = useTransition();
  const [profile, setProfile] = useState<HackerProfile>(() => initial?.hacker ?? { ...DEFAULT_HACKER, handle: rollHandle() });
  // The room opens on a still of its first frame, where there is one for this hacker's look.
  const [still] = useState(() => (looksDefault(profile) ? ("onboard" as const) : undefined));
  const [company, setCompany] = useState(initial?.company ?? { name: "", email: "" });
  const [credits, setCredits] = useState<number>(DEFAULT_CREDITS);
  const [autoTopUp, setAutoTopUp] = useState(true);
  // Business invoices: a name and address from Stripe's Address Element, and a tax ID typed here.
  const [business, setBusiness] = useState(false);
  const [taxId, setTaxId] = useState("");
  const [taxCountry, setTaxCountry] = useState<string | null>(null);
  // A promotion code, checked against this purchase. A different amount of credits needs it checked again.
  const [discount, setDiscount] = useState<Extract<DiscountCheck, { discount: number }> | null>(null);
  // A tester's code typed at checkout: free credits for this account instead of paying.
  const [codeClaim, setCodeClaim] = useState<{ orgId: string; code: string; credits: number } | null>(null);
  const [discountFor, setDiscountFor] = useState(credits);
  if (discountFor !== credits) {
    setDiscountFor(credits);
    setDiscount(null);
  }
  const applyDiscount = async (code: string): Promise<string | null> => {
    if (demo) {
      // The dev preview has no billing: DEMO20 takes 20% off, DEMOFREE gives free credits, anything else is refused.
      if (code.trim().toUpperCase() === "DEMOFREE") {
        takeFreeCode({ code: "DEMOFREE", freeCredits: FREE_CREDITS.credits });
        return null;
      }
      if (code.trim().toUpperCase() !== "DEMO20") return "That code isn’t valid, or has expired.";
      const full = PLAN.price + creditsPrice(credits);
      setDiscount({ code: "DEMO20", discount: Math.round(full * 20) / 100, dueToday: Math.round(full * 80) / 100 });
      return null;
    }
    if (!brief) return "Codes can’t be checked right now. Try again in a minute.";
    const checked = await checkDiscount(brief.orgId, code, order);
    if ("error" in checked) return checked.error;
    if ("freeCredits" in checked) takeFreeCode(checked);
    else setDiscount(checked);
    return null;
  };
  /** A tester's code: back to the Credits step, which now claims the free credits with no card. */
  const takeFreeCode = (checked: { code: string; freeCredits: number }) => {
    if (!brief) return;
    setCodeClaim({ orgId: brief.orgId, code: checked.code, credits: checked.freeCredits });
    setStep(3);
    nudge(1);
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

  // Free credits: what this account would get from claiming, unless the server found it can't after all.
  // From /claim (the cookie), or from a code typed at checkout for this account.
  const code = codeClaim && codeClaim.orgId === brief?.orgId ? codeClaim : null;
  const intent: ClaimIntent | null = claim ?? (code ? { credits: code.credits, offers: { [code.orgId]: { open: true, credits: code.credits } } } : null);
  const offer: ClaimOffer | null = intent && brief ? (code ? { open: true, credits: code.credits } : (intent.offers[brief.orgId] ?? null)) : null;
  const claimClosedHere = !!state.claimClosed;
  const claiming = billing && !!intent && !brief?.currentPlan && !claimClosedHere && (!brief || offer?.open === true);
  const payOnPage = billing && !claiming && !!publishableKey && !brief?.currentPlan && payment.state !== "failed";
  // Paying on this page is a step of its own, in the same panel as every other, so nothing moves when it opens.
  const steps: StepId[] = payOnPage ? ["connect", "company", "hacker", "plan", "pay"] : ["connect", "company", "hacker", "plan"];
  const [step, setStep] = useState(() => (startAt === "company" && initial ? 1 : 0));
  const current = steps[Math.min(step, steps.length - 1)]!;
  const org = brief?.login ?? accounts[0]?.login ?? viewer;
  const name = profile.handle.trim() || "your hacker";
  const handleOk = validHandle(profile.handle);
  const companyOk = company.name.trim().length > 0 && (EMAIL.test(company.email.trim()) || (!billing && company.email.trim() === ""));
  const busy = pending || payment.state === "paying" || signed || signingIn;
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

  // Each step shown, for where people stop on the way to recruiting.
  useEffect(() => {
    if (!demo) trackStep("recruit", current);
  }, [demo, current]);

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
    org,
    credits,
    autoTopUp,
    currentPlan: brief?.currentPlan ?? null,
    billing,
    claim: claiming ? (intent?.credits ?? null) : null,
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
      if (next.hacker) setProfile(next.hacker);
      setPayment({ state: "idle" });
      history.replaceState(null, "", `/dashboard/recruit?org=${next.orgId}`);
      nudge(1);
    });
  };

  // Recruiting in progress is kept in the browser, per org, so a reload picks up where it left off. It's read
  // back before the first paint, then kept up to date; once the org has joined there's nothing to keep.
  const restored = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (demo || !brief || restored.current === brief.orgId) return;
    const first = restored.current === null;
    restored.current = brief.orgId;
    const key = draftKey(brief.orgId);
    try {
      if (brief.currentPlan) return localStorage.removeItem(key);
      const draft = readDraft(localStorage.getItem(key));
      if (!draft) return;
      setProfile(draft.hacker);
      setCompany(draft.company);
      setCredits(draft.credits);
      setAutoTopUp(draft.autoTopUp);
      // The step it was left on, on first load only (choosing another account stays on the first step), and no
      // further than what's filled in allows.
      if (first) setStep(reachable(draft));
    } catch {
      // Storage can be off (private windows, blocked cookies): recruiting works as before, without memory.
    }
  }, [brief]);
  useEffect(() => {
    if (demo || !brief || brief.currentPlan || restored.current !== brief.orgId || signed) return;
    const draft: RecruitDraft = { step: current, hacker: profile, company, credits, autoTopUp };
    try {
      localStorage.setItem(draftKey(brief.orgId), JSON.stringify(draft));
    } catch {
      // Full or off: nothing to remember with.
    }
  }, [demo, brief, current, profile, company, credits, autoTopUp, signed]);
  const forget = () => {
    try {
      if (brief) localStorage.removeItem(draftKey(brief.orgId));
    } catch {}
  };
  /** The step a draft was left on, or the furthest before it that its answers allow. */
  const reachable = (draft: RecruitDraft) => {
    const at = steps.indexOf(draft.step);
    const to = at < 0 ? steps.indexOf("plan") : at;
    const filled = (id: StepId) =>
      id === "company"
        ? draft.company.name.trim().length > 0 && (EMAIL.test(draft.company.email.trim()) || (!billing && draft.company.email.trim() === ""))
        : id === "hacker"
          ? validHandle(draft.hacker.handle)
          : true;
    const stop = steps.slice(0, to).findIndex((id) => !filled(id));
    return stop < 0 ? to : stop;
  };

  const recruitment = (): RecruitInput => ({ hacker: profile, company: { name: company.name.trim(), email: company.email.trim() } });
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
    if ((current !== "plan" && current !== "pay") || !brief || !billing || claiming || !publishableKey || brief.currentPlan || payment.state !== "idle" || opening.current) return;
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
    forget();
    setSigned(true);
    setTimeout(() => (outcome.next.startsWith("/") ? router.push(outcome.next) : window.location.assign(outcome.next)), 1_600);
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    if (busy) return event.preventDefault();
    if (current === "plan" && !payOnPage) {
      // The last step without a card form: the server saves it all and joins the plan (on Stripe Checkout).
      // Without billing that's the end; with it, a draft stays until the plan is active, should they come back.
      if (!billing) forget();
      nudge(3);
      return;
    }
    event.preventDefault();
    if (current === "connect" && signIn) startSignIn(() => signIn());
    else if (current === "connect" && !brief && installUrl) window.location.assign(installUrl);
    else if (current === "pay") void pay();
    else go(step + 1);
  };

  const total = discount?.dueToday ?? PLAN.price + creditsPrice(credits);
  const forward = (() => {
    if (pending || signingIn) return "One moment…";
    if (current === "connect" && signIn) return "Continue with GitHub";
    if (current === "connect") return brief ? `Continue as ${brief.login}` : accounts.length === 0 ? "Connect GitHub" : "Choose an account";
    if (current === "company") return "Continue";
    if (current === "hacker") return `Recruit ${name}`;
    if (current === "plan") {
      if (!billing) return `Add ${name} to ${org}`;
      if (brief?.currentPlan) return "Save";
      if (claiming) return `Claim ${creditCount(intent!.credits)} free credits`;
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
  const forwardOk = current === "connect" ? !!signIn || !!brief || (accounts.length === 0 && !!installUrl) : checkout ? payment.state === "ready" : done(current);

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
        {/* Signed out there is no dashboard to go back to: the mark and the way out lead home. */}
        <Link href={signIn ? "/" : "/dashboard?later=1"} className="onboard-mark" aria-label={signIn ? "Sandchest home" : "Sandchest dashboard"}>
          <img src="/sandchest-logo-dark.svg" alt="" width={120} height={22} />
        </Link>
        <Progress steps={steps} step={step} canEnter={canEnter} go={go} />
        <div className="onboard-exits">
          <AgentPromptButton className="onboard-leave onboard-agent" track="onboard-agent-prompt" label="Let your agent do it" />
          <Link href={signIn ? "/" : "/dashboard?later=1"} className="onboard-leave">
            {signIn ? "Back" : brief?.hacker ? "Back to the dashboard" : "Finish later"}
          </Link>
        </div>
      </header>

      <form ref={form} action={action} className="onboard-hud" onKeyDown={onKeyDown} onSubmit={onSubmit}>
        <input type="hidden" name="recruitment" value={JSON.stringify(recruitment())} />
        {billing && <input type="hidden" name="order" value={JSON.stringify(order)} />}
        {claiming && <input type="hidden" name="claim" value="1" />}

        <section className="onboard-panel" data-aside={placed || undefined} data-moving={moving || undefined} aria-labelledby="onboard-title">
          <div className="onboard-body" key={current}>
            {current === "connect" && (
              <Connect
                heading={heading}
                accounts={accounts}
                chosen={brief?.orgId ?? null}
                switching={switching}
                choose={choose}
                installUrl={installUrl}
                signedOut={!!signIn}
                viewer={viewer}
                claim={billing ? claim : null}
              />
            )}
            {current === "company" && brief && (
              <Company heading={heading} brief={brief} company={company} setCompany={setCompany} billing={billing} />
            )}
            {current === "hacker" && <Hacker heading={heading} profile={profile} update={update} look={look} setLook={setLook} />}
            {current === "plan" && (
              <Credits
                heading={heading}
                brief={brief}
                billing={billing}
                name={name}
                org={org}
                credits={credits}
                setCredits={setCredits}
                autoTopUp={autoTopUp}
                setAutoTopUp={setAutoTopUp}
                payOnPage={payOnPage}
                claim={claiming ? intent!.credits : null}
                code={claiming && code ? { code: code.code, remove: () => setCodeClaim(null) } : null}
                closed={billing && intent && brief && !brief.currentPlan && !claiming ? (offer && !offer.open ? closedMessage(offer, org) : null) : null}
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
              <button type="button" className="onboard-back" onClick={() => go(step - 1)} disabled={busy} data-track={`recruit-back-${current}`}>
                <span className="onboard-face">
                  <Key>Esc</Key>
                  Back
                </span>
              </button>
            )}
            <button type="submit" className="onboard-go" disabled={!forwardOk || busy} data-track={`recruit-next-${current}`}>
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
      {/* With no account to pick yet, the GitHub step has nothing to choose with the arrows. */}
      <Hints current={current} choices={current === "plan" ? billing && !claiming && !brief?.currentPlan : current !== "connect" || accounts.length > 0} />
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
              <button type="button" onClick={() => go(i)} disabled={i === step || !canEnter(i)} aria-current={state === "current" ? "step" : undefined} data-track="recruit-step-nav">
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
function Hints({ current, choices }: { current: StepId; choices: boolean }) {
  const hints: [string, string][] = !choices
    ? []
    : current === "hacker"
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

/** The free credits waiting at the end, shown from the first step for someone who came to claim them. */
function FreeCreditsBadge({ credits }: { credits: number }) {
  return (
    <p className="onboard-badge">
      <span className="onboard-badge-n">{creditCount(credits)}</span> free credits, no card
    </p>
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
  signedOut,
  viewer,
  claim,
}: {
  heading: RefObject<HTMLHeadingElement | null>;
  accounts: RecruitAccount[];
  chosen: string | null;
  switching: boolean;
  choose: (account: RecruitAccount) => void;
  installUrl: string | null;
  signedOut: boolean;
  viewer: string;
  claim: ClaimIntent | null;
}) {
  const skeleton = useInSkeleton();
  const gift = claim && <FreeCreditsBadge credits={claim.credits} />;
  // Nothing connected yet: the way there in three short lines, ticked off as they're done.
  if (accounts.length === 0) {
    const path: Array<{ label: string; state: "done" | "now" | "next" }> = [
      { label: signedOut ? "Sign in with GitHub" : `Signed in as ${viewer}`, state: signedOut ? "now" : "done" },
      { label: "Pick the repositories that matter most", state: signedOut ? "next" : "now" },
      { label: "Come back here to brief your hacker", state: "next" },
    ];
    return (
      <div className="onboard-connect">
        <Title heading={heading}>Connect GitHub</Title>
        {gift}
        <p className="onboard-lead">{claim ? `Your hacker works from your repositories. Connect them to claim ${creditCount(claim.credits)} free credits, no card needed.` : "Your hacker works from your repositories."}</p>
        <ol className="onboard-path">
          {path.map((item) => (
            <li key={item.label} data-state={item.state}>
              {item.label}
            </li>
          ))}
        </ol>
        <p className="onboard-help">Choose only the repositories you want scanned, not the whole account: {MANY_REPOS} or fewer works best. You can add more any time.</p>
        <ReadOnlyNote />
      </div>
    );
  }
  return (
    <>
      <Title heading={heading}>Connect GitHub</Title>
      {gift}
      <p className="onboard-lead">{claim ? "Pick the account your hacker works for. Its free credits come with it." : "Pick the account your hacker works for."}</p>
      <fieldset className="onboard-set" aria-busy={switching || undefined}>
        <legend className="onboard-label">Account</legend>
        <ul className="onboard-menu">
          {accounts.map((account) => (
            <li key={account.id}>
              <label className="onboard-option onboard-account" data-on={chosen === account.id || undefined}>
                <input type="radio" name="account" checked={chosen === account.id} onChange={() => choose(account)} />
                <img src={skeleton ? BLANK : `https://github.com/${encodeURIComponent(account.login)}.png?size=80`} alt="" width={36} height={36} />
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
      {installUrl && (
        <a className="onboard-link" href={installUrl}>
          <GitHubMark /> Connect another account
        </a>
      )}
      <ReadOnlyNote />
    </>
  );
}

/** What connecting GitHub hands over, for anyone wary of an unrestricted model near their code. */
function ReadOnlyNote() {
  return (
    <p className="onboard-fine">
      <Lock />
      <span>
        Read-only. Each scan runs in its own VM, deleted when it ends, and your code is never stored.{" "}
        <a href={site.links.security} target="_blank" rel="noreferrer">
          How your code is handled
        </a>
      </span>
    </p>
  );
}

function Company({
  heading,
  brief,
  company,
  setCompany,
  billing,
}: {
  heading: RefObject<HTMLHeadingElement | null>;
  brief: Briefing;
  company: { name: string; email: string };
  setCompany: (company: { name: string; email: string }) => void;
  billing: boolean;
}) {
  const { profile } = brief;
  const skeleton = useInSkeleton();
  return (
    <>
      <Title heading={heading}>Your company</Title>
      <div className="onboard-card">
        <img src={skeleton ? BLANK : profile.avatar} alt="" width={52} height={52} />
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

      <RepoScope brief={brief} />
    </>
  );
}

/**
 * How many repositories the hacker will work on. Sandchest maps and reviews every one it can see, so a whole
 * account connected by accident is caught here, with the way to narrow it on GitHub.
 */
function RepoScope({ brief }: { brief: Briefing }) {
  const count = brief.repos.length;
  if (count === 0) return <p className="onboard-note">No repositories yet. Add some to the installation on GitHub and they’ll show here.</p>;
  const many = count > MANY_REPOS;
  return (
    <div className="onboard-scope" data-many={many || undefined}>
      <p className="onboard-scope-count">
        <span className="onboard-scope-n">{count.toLocaleString("en-US")}</span> {count === 1 ? "repository" : "repositories"} connected
      </p>
      {many ? (
        <p className="onboard-scope-note">
          That’s a lot. Your hacker maps and reviews every repository it can see, so connect the ones that matter most: {MANY_REPOS} or fewer works best. You can add more any time.
        </p>
      ) : (
        <p className="onboard-scope-note">You choose which one your hacker deep scans first, from your dashboard.</p>
      )}
      {many && brief.chooseRepos && (
        <a className="onboard-link" href={brief.chooseRepos} target="_blank" rel="noreferrer" data-track="recruit-choose-repos">
          <GitHubMark /> Choose repositories on GitHub
        </a>
      )}
    </div>
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
  const name = useRef<HTMLInputElement>(null);
  const move = useRef<((by: number) => void) | null>(null);
  return (
    <>
      <Title heading={heading}>Your hacker</Title>
      <label className="onboard-label onboard-name-label" htmlFor="onboard-handle">
        Name
      </label>
      <HandleField id="onboard-handle" inputRef={name} profile={profile} update={update} onFocus={() => setLook(-1)} onDown={() => move.current?.(1)} />
      <p id="handle-help" className={handleOk ? "onboard-help" : "onboard-help onboard-bad"}>
        {handleOk ? "The name on their scans and reviews." : "Start with a letter or number, and keep it to 16 characters."}
      </p>
      <LookMenu profile={profile} update={update} look={look} setLook={setLook} onTop={() => name.current?.focus()} move={move} />
    </>
  );
}

/** What auto top-up charges, and when: said in full wherever it can be turned off. */
function autoTopUpTerms(credits: number): string {
  return `Auto top-up adds ${creditCount(credits)} credits for ${usd(creditsPrice(credits))} whenever fewer than ${creditCount(TOP_UP_BELOW)} are left, up to ${usd(DEFAULT_TOP_UP_LIMIT_USD)} a month. Change the limit any time in Settings. `;
}
const AUTO_TOP_UP_OFF = "Auto top-up is off, so pull request reviews stop when the credits run out. ";

/**
 * Auto top-up is on unless they turn it off: a quiet link rather than a switch, so it reads as part of the
 * terms, not a choice to make. Each way is recorded, to see how many turn it off.
 */
function AutoTopUpSwitch({ on, set }: { on: boolean; set: (on: boolean) => void }) {
  return (
    <button type="button" className="onboard-bill-link" onClick={() => set(!on)} data-track={on ? "recruit-auto-top-up-off" : "recruit-auto-top-up-on"}>
      {on ? "Turn off" : "Turn back on"}
    </button>
  );
}

function Credits({
  heading,
  brief,
  billing,
  name,
  org,
  credits,
  setCredits,
  autoTopUp,
  setAutoTopUp,
  payOnPage,
  claim,
  code,
  closed,
}: {
  heading: RefObject<HTMLHeadingElement | null>;
  brief: Briefing | null;
  billing: boolean;
  name: string;
  org: string;
  credits: number;
  setCredits: (credits: number) => void;
  autoTopUp: boolean;
  setAutoTopUp: (on: boolean) => void;
  /** A Pay step follows, which says what auto top-up charges and has the way to turn it off. */
  payOnPage: boolean;
  /** Free credits to claim instead of paying. */
  claim: number | null;
  /** The code at checkout that gave them, which can be taken back to pay instead. */
  code: { code: string; remove: () => void } | null;
  /** Why free credits aren't on offer for this account, when the person came for them. */
  closed: string | null;
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
  const usage = brief?.usage;
  const all = digAllCredits(repos, usage?.deepScan);
  const scans = DEEP_SCAN_TIERS.map((tier) => tier.credits);
  const rates = (
    <dl className="onboard-rates">
      <div>
        <dt>Pull request review</dt>
        <dd>{usage ? `Up to ${creditsText(usage.prReview)}` : creditsText(PR_REVIEW_TIERS[0]!.credits)}</dd>
      </div>
      <div>
        <dt>Deep scan</dt>
        {usage ? (
          <dd>Up to {creditsText(usage.deepScan)}</dd>
        ) : (
          <dd>
            {creditCount(scans[0]!)}–{creditCount(scans.at(-1)!)} credits
          </dd>
        )}
      </div>
    </dl>
  );

  if (claim !== null) {
    return (
      <>
        <Title heading={heading}>Claim your credits</Title>
        <div className="onboard-gift">
          <span className="onboard-gift-n">{creditCount(claim)}</span>
          <span className="onboard-gift-what">
            <span className="onboard-gift-name">free credits</span>
            <span className="onboard-gift-price">
              <s>{usd(creditsWorth(claim))}</s> $0.00 · no card
            </span>
          </span>
        </div>
        {code && (
          <p className="onboard-help onboard-gift-code">
            Code {code.code} applied.{" "}
            <button type="button" className="onboard-bill-link" onClick={code.remove} data-track="recruit-code-remove">
              Remove
            </button>
          </p>
        )}
        <p className="onboard-lead onboard-gift-lead">
          On us, to test {name} on {org}’s code. They work like any credits.
        </p>
        {rates}
        <p className="onboard-help">
          When they’re spent, {name} stops until {org} joins: ${PLAN.price} a month, and credits from {perCredit(PLAN_CREDIT_PRICE)}. Anything left over carries across.
        </p>
      </>
    );
  }

  const picker = (
    <>
      {closed && <p className="onboard-notice">{closed} You can still join below.</p>}
      <p className="onboard-lead">
        ${PLAN.price} a month, plus credits for the work. Credits never expire.
      </p>
      {rates}
      <fieldset className="onboard-set">
        <legend className="onboard-label">Start with</legend>
        <div className="onboard-amounts">
          {CREDIT_AMOUNTS.map((amount) => (
            <label key={amount} className="onboard-amount" data-on={credits === amount || undefined}>
              <input type="radio" name="credits-pick" checked={credits === amount} onChange={() => setCredits(amount)} />
              <span className="onboard-amount-n">{creditCount(amount)}</span>
              <span className="onboard-amount-usd">{usd(creditsPrice(amount))}</span>
              {creditsSaving(amount) > 0 && <span className="onboard-amount-save">Save {usd(creditsSaving(amount))}</span>}
            </label>
          ))}
        </div>
        {all > 0 && repos.length <= MANY_REPOS && (
          <p className="onboard-help">
            Deep scanning {repos.length === 1 ? `${org}’s repository` : `all ${repos.length} of ${org}’s repositories`} takes {usage ? `up to ${creditCount(all)}` : creditCount(all)} credits.
          </p>
        )}
      </fieldset>
      <p className="onboard-help">
        {autoTopUp ? autoTopUpTerms(credits) : AUTO_TOP_UP_OFF}
        {!payOnPage && <AutoTopUpSwitch on={autoTopUp} set={setAutoTopUp} />}
      </p>
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
  discount: Extract<DiscountCheck, { discount: number }> | null;
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
              {creditCount(credits)} credits
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
                <button type="button" className="onboard-bill-link" onClick={removeDiscount} data-track="recruit-discount-remove">
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
        <div className="onboard-bill-toggle onboard-bill-auto">
          <span>
            <span className="onboard-bill-toggle-name">Then, as you use them</span>
            <span className="onboard-bill-toggle-note">{autoTopUp ? autoTopUpTerms(credits) : AUTO_TOP_UP_OFF}</span>
          </span>
          <AutoTopUpSwitch on={autoTopUp} set={setAutoTopUp} />
        </div>
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

/** "Have a code?": a link until it's wanted, then a field and Apply. A discount code, or a tester's code for free credits. */
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
        <button type="button" className="onboard-bill-link" onClick={() => setOpen(true)} data-track="recruit-have-code">
          Have a code?
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
          placeholder="Code"
          aria-label="Discount or free credits code"
          aria-invalid={!!error || undefined}
          aria-describedby={error ? "discount-error" : undefined}
          maxLength={64}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
        />
        <button type="button" className="onboard-discount-apply" onClick={() => void submit()} disabled={!code.trim() || checking} data-track="recruit-code-apply">
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

// ---- Pixel icons -----------------------------------------------------------------

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

// ---- Loading state ---------------------------------------------------------------

const noop = () => {};
const SAMPLE_REPOS = ["api", "web", "billing", "worker", "docs", "mobile"].map((name, i) => ({
  id: `sample-${i}`,
  fullName: `acme/${name}`,
  private: name !== "docs",
  loc: 48_000 + i * 9_000,
  language: "TypeScript",
  description: null,
}));
const SAMPLE_BRIEF: Briefing = {
  orgId: "sample",
  login: "acme",
  type: "Organization",
  profile: { name: "Acme", about: "Billing for teams that ship every day.", website: "https://acme.example.com", location: null, avatar: BLANK },
  repos: SAMPLE_REPOS,
  chooseRepos: null,
  company: { name: "Acme", email: "billing@example.com" },
  hacker: null,
  currentPlan: null,
};

/**
 * Recruiting's loading state, while GitHub is read: the dark room and the
 * page's own header and panel, at once, with the step that opens (GitHub, or
 * Company when `?org=` names an account) drawn from sample data and measured
 * into a skeleton. The room's 3D scene starts with the page.
 */
export function RecruitSkeleton({ billing, payOnPage, install }: { billing: boolean; payOnPage: boolean; install: boolean }) {
  const heading = useRef<HTMLHeadingElement>(null);
  const company = !!useSearchParams().get("org");
  const steps: StepId[] = billing && payOnPage ? ["connect", "company", "hacker", "plan", "pay"] : ["connect", "company", "hacker", "plan"];
  const step = company ? 1 : 0;
  const account: RecruitAccount = { id: SAMPLE_BRIEF.orgId, login: SAMPLE_BRIEF.login, type: "Organization", planId: null, handle: null };
  return (
    <div className="onboard" aria-busy="true">
      <div className="onboard-shade" aria-hidden="true" />
      <header className="onboard-top">
        <Link href="/dashboard?later=1" prefetch={false} className="onboard-mark" aria-label="Sandchest dashboard">
          <img src="/sandchest-logo-dark.svg" alt="" width={120} height={22} />
        </Link>
        <Progress steps={steps} step={step} canEnter={() => false} go={noop} />
        <Link href="/dashboard?later=1" prefetch={false} className="onboard-leave">
          Finish later
        </Link>
      </header>
      <div className="onboard-hud">
        <section className="onboard-panel" aria-label="Loading">
          <div className="onboard-body">
            <PageSkeleton id="recruit" label="Loading">
              {company ? (
                <Company heading={heading} brief={SAMPLE_BRIEF} company={SAMPLE_BRIEF.company} setCompany={noop} billing={billing} />
              ) : (
                <Connect heading={heading} accounts={[account]} chosen={account.id} switching={false} choose={noop} installUrl={install ? "#" : null} signedOut={false} viewer="" claim={null} />
              )}
            </PageSkeleton>
          </div>
          {/* Inert, not disabled: the keys look as they will once the step is ready. */}
          <footer className="onboard-foot" inert>
            {step > 0 && (
              <button type="button" className="onboard-back">
                <span className="onboard-face">
                  <Key>Esc</Key>
                  Back
                </span>
              </button>
            )}
            <button type="button" className="onboard-go">
              <span className="onboard-face">
                <span className="onboard-go-label">Continue</span>
                <Key>Enter</Key>
              </span>
            </button>
          </footer>
        </section>
      </div>
      <Hints current={steps[step]!} choices />
    </div>
  );
}

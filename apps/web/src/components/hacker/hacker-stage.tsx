"use client";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition, type CSSProperties } from "react";
import { useDemo } from "@/components/app/demo";
import { HoverLink } from "@/components/app/hover-link";
import { recruitPainter, type RecruitModel } from "@/components/rig/paint-recruit";
import { RigView } from "@/components/rig/rig-view";
import type { Painter } from "@/components/rig/screen";
import type { ShotName } from "@/components/rig/shots";
import { newSignals } from "@/components/rig/signals";
import { PHOSPHORS, swatch, validHandle, type HackerProfile } from "@/lib/hacker";
import { saveHacker, type SaveHackerOutcome } from "@/server/hacker-actions";
import { HandleField } from "./handle-field";
import { Keycap } from "./keycap";
import { LookMenu, LOOKS } from "./look-menu";
import { RadioKeys, useRadio } from "./radio";

/** How far right the picture sits on wide screens: a little to clear the name, more while the customize panel covers the left. */
const SHIFT = { resting: 0.12, editing: 0.17 };

interface Props {
  orgId: string;
  login: string;
  profile: HackerProfile;
  /** Whether this person may change the hacker. */
  admin: boolean;
  /** What they're doing right now, if anything. */
  job: { href: string; label: string; queued: boolean } | null;
}

/**
 * The hacker at their desk, filling the top of their page: drag to look
 * around the room, their name and what they're up to over it. Admins can
 * customize them in place: a game menu over the room's dark side while the
 * camera turns to whatever is being changed, saved as one change.
 */
export function HackerStage({ orgId, login, profile: saved, admin, job }: Props) {
  const router = useRouter();
  const demo = useDemo();
  const [editing, setEditing] = useState(false);
  const [profile, setProfile] = useState(saved);
  const [look, setLook] = useState(-1);
  const [error, setError] = useState<string | null>(null);
  const [saving, startSave] = useTransition();
  const [dragged, setDragged] = useState(false);
  const signals = useRef(newSignals());
  const wide = useWide();
  const name = useRef<HTMLInputElement>(null);
  const move = useRef<((by: number) => void) | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const edit = useRef<HTMLButtonElement>(null);
  // Up here, not in the card, so the music carries on while they customize.
  const radio = useRadio();

  // The look as last saved: the server's, or ours the moment a save succeeds (before the page refreshes with it,
  // so the room never flicks back to the old look in between). A new one from the server is taken unless editing.
  const [base, setBase] = useState(saved);
  const [seen, setSeen] = useState(saved);
  if (seen !== saved) {
    setSeen(saved);
    setBase(saved);
    if (!editing) setProfile(saved);
  }

  const model = useRef<RecruitModel>(null!);
  model.current = { step: editing ? "customize" : "hacker", profile, viewer: login, accounts: [], repos: [], org: login, credits: 0, autoTopUp: false, currentPlan: null, billing: false };
  const [paint] = useState<{ current: Painter | null }>(() => ({ current: recruitPainter(model) }));

  const changed = JSON.stringify(profile) !== JSON.stringify(base);
  const handleOk = validHandle(profile.handle);
  const update = (patch: Partial<HackerProfile>) => {
    setProfile((p) => ({ ...p, ...patch }));
    setError(null);
    signals.current.typingUntil = signals.current.now + 0.5;
  };
  const open = () => {
    setEditing(true);
    setError(null);
  };
  const close = () => {
    setEditing(false);
    setLook(-1);
    setProfile(base);
    setError(null);
    requestAnimationFrame(() => edit.current?.focus());
  };
  const save = () => {
    if (!changed) return close();
    if (!handleOk || saving) return;
    startSave(async () => {
      // The demo's hacker changes for this visit only: there's no account to save it to.
      const outcome: SaveHackerOutcome = demo ? { ok: true } : await saveHacker(orgId, profile);
      if ("error" in outcome) return setError(outcome.error);
      setBase(profile);
      setEditing(false);
      setLook(-1);
      signals.current.joltUntil = signals.current.now + 0.4;
      if (!demo) router.refresh();
      requestAnimationFrame(() => edit.current?.focus());
    });
  };

  // The panel opens on the name; Esc leaves without saving, Enter (outside a field's own use) saves.
  useEffect(() => {
    if (editing) name.current?.focus({ preventScroll: true });
  }, [editing]);
  const keys = useRef({ save, close, open, editing, admin, radio });
  keys.current = { save, close, open, editing, admin, radio };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const k = keys.current;
      const at = document.activeElement;
      const typing = at instanceof HTMLInputElement && at.type === "text";
      if (k.editing && event.key === "Escape") {
        event.preventDefault();
        k.close();
      } else if (k.editing && event.key === "Enter" && (!(at instanceof HTMLButtonElement) || panel.current?.contains(at) === false)) {
        event.preventDefault();
        k.save();
      } else if (!k.editing && k.admin && (event.key === "c" || event.key === "C") && !typing && !(at instanceof HTMLTextAreaElement)) {
        event.preventDefault();
        k.open();
      } else if (!k.editing && k.radio.supported && (event.key === "r" || event.key === "R") && !typing && !(at instanceof HTMLTextAreaElement)) {
        event.preventDefault();
        k.radio.toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // At rest: side on against the screen's glow where there's width for it; face to face on a tall phone screen.
  const shot: ShotName = editing && look >= 0 ? LOOKS[look]!.shot : wide ? "preview" : "hood";
  const phosphor = swatch(PHOSPHORS, profile.phosphor).color;

  return (
    <section className="hq-stage" data-editing={editing || undefined} style={{ "--phosphor": phosphor } as CSSProperties} aria-labelledby="hq-name">
      <div className="hq-scene" onPointerDown={() => setDragged(true)}>
        <RigView profile={profile} org={login} shot={shot} paint={paint} signals={signals} frameShift={wide ? SHIFT[editing ? "editing" : "resting"] : 0} drag="look" poster />
        <div className="hq-shade" aria-hidden="true" />
        {!editing && (
          <p className="hq-hint" data-gone={dragged || undefined} aria-hidden="true">
            <DragIcon /> Drag to look around
          </p>
        )}
      </div>

      {editing ? (
        <div ref={panel} className="hq-panel" role="group" aria-label={`Customize ${profile.handle || "your hacker"}`}>
          <div className="hq-panel-body">
            <h2 className="hq-panel-title">Customize</h2>
            <label className="onboard-label onboard-name-label" htmlFor="hq-handle">
              Name
            </label>
            <HandleField id="hq-handle" inputRef={name} profile={profile} update={update} onFocus={() => setLook(-1)} onDown={() => move.current?.(1)} />
            <p id="handle-help" className={handleOk ? "onboard-help" : "onboard-help onboard-bad"}>
              {handleOk ? "The name on their scans and reviews." : "Start with a letter or number, and keep it to 16 characters."}
            </p>
            <LookMenu profile={profile} update={update} look={look} setLook={setLook} onTop={() => name.current?.focus()} move={move} />
            {error && (
              <p className="onboard-error" role="alert">
                {error}
              </p>
            )}
          </div>
          <div className="hq-panel-foot">
            <button type="button" className="cap-key" onClick={close} disabled={saving} data-track="hacker-customize-cancel">
              <span className="cap-key-face">
                <Keycap>Esc</Keycap> Cancel
              </span>
            </button>
            <button type="button" className="cap-key cap-key-gold" onClick={save} disabled={!handleOk || saving} data-track="hacker-customize-save">
              <span className="cap-key-face">
                {saving ? "Saving…" : changed ? `Save ${profile.handle}` : "Done"} <Keycap>Enter</Keycap>
              </span>
            </button>
          </div>
        </div>
      ) : (
        <div className="hq-card">
          <p className="hq-of">{login}’s hacker</p>
          <h1 id="hq-name" className="hq-name">
            {profile.handle}
          </h1>
          <div className="hq-actions">
            {job ? (
              <HoverLink href={job.href} className="cap-key cap-key-gold">
                <span className="cap-key-face">
                  <span className="hq-live" aria-hidden="true" />
                  {job.queued ? "Waiting to start " : "On "}
                  {job.label}
                  <span className="cap-key-go">Watch</span>
                </span>
              </HoverLink>
            ) : (
              <p className="hq-idle">
                <span className="hq-idle-dot" aria-hidden="true" /> Off duty. Ready for the next pull request.
              </p>
            )}
            {admin && (
              <button ref={edit} type="button" className="cap-key" onClick={open} data-track="hacker-customize-open">
                <span className="cap-key-face">
                  Customize <Keycap>C</Keycap>
                </span>
              </button>
            )}
            <RadioKeys radio={radio} />
          </div>
          {!admin && <p className="hq-note">Only an admin of {login} can change how {profile.handle} looks.</p>}
        </div>
      )}
    </section>
  );
}

/** Wide enough for the panel beside the hacker. */
function useWide(): boolean {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const query = matchMedia("(min-width: 60rem)");
    setWide(query.matches);
    const change = () => setWide(query.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  return wide;
}

function DragIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 7 7" shapeRendering="crispEdges" aria-hidden="true">
      <path fill="currentColor" d="M3 0h1v7H3zM0 3h7v1H0zM2 1h3v1H2zM2 5h3v1H2zM1 2h1v3H1zM5 2h1v3H5z" />
    </svg>
  );
}

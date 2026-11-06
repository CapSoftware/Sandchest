"use client";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition, type CSSProperties } from "react";
import type { HackerRecord } from "@sandchest/db";
import { useDemo } from "@/components/app/demo";
import { accountPainter, type AccountModel } from "@/components/rig/paint-account";
import { recruitPainter, type RecruitModel } from "@/components/rig/paint-recruit";
import { RigView } from "@/components/rig/rig-view";
import type { Painter } from "@/components/rig/screen";
import type { ShotName } from "@/components/rig/shots";
import { newSignals } from "@/components/rig/signals";
import type { FeedItem, FeedJob } from "@/lib/account-feed";
import { demoFeed } from "@/lib/demo-feed";
import { PHOSPHORS, swatch, validHandle, type HackerProfile } from "@/lib/hacker";
import { saveHacker, type SaveHackerOutcome } from "@/server/hacker-actions";
import { serverFeed, useAccountLive } from "./account-live";
import { FeedDrawer, nowDoing, type Crew } from "./feed-drawer";
import { HandleField } from "./handle-field";
import { Keycap } from "./keycap";
import { LookMenu, LOOKS } from "./look-menu";
import { useKeySounds } from "./key-sounds";
import { useRadio } from "./radio";
import { SoundMenu } from "./sound-menu";

/** How far right the picture sits on wide screens: a little to clear the name, more while the customize panel covers the left. */
const SHIFT = { resting: 0.12, editing: 0.17 };

interface Props {
  orgId: string;
  login: string;
  profile: HackerProfile;
  /** Whether this person may change the hacker. */
  admin: boolean;
  /** The account's feed as the page opens; the page follows it live from there. */
  feed: { items: FeedItem[]; jobs: FeedJob[] };
  record: HackerRecord;
  /** The person's other hackers, to switch to. */
  crew: Crew[];
}

/**
 * The hacker's page: them at their desk filling the window, live. Their
 * name and what they're on over the room, a Live mark in the corner, their
 * screen showing what's happening on the account as it happens, and the
 * feed itself in a drawer that comes up from the foot on request. Drag to
 * look around the room. Admins can customize them in place: a game menu
 * over the room's dark side while the camera turns to whatever is being
 * changed, saved as one change.
 */
export function HackerStage({ orgId, login, profile: saved, admin, feed: initial, record, crew }: Props) {
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
  const sounds = useKeySounds(signals);

  // The look as last saved: the server's, or ours the moment a save succeeds (before the page refreshes with it,
  // so the room never flicks back to the old look in between). A new one from the server is taken unless editing.
  const [base, setBase] = useState(saved);
  const [seen, setSeen] = useState(saved);
  if (seen !== saved) {
    setSeen(saved);
    setBase(saved);
    if (!editing) setProfile(saved);
  }

  // The account, live: the demo's made up, everyone else's from the server.
  const source = useMemo(() => (demo ? demoFeed() : serverFeed(orgId)), [demo, orgId]);
  const live = useAccountLive(initial, source);
  const [drawer, setDrawer] = useDrawer();

  // The screen: the account's feed, or the customize menu while customizing.
  const model = useRef<RecruitModel>(null!);
  model.current = { step: "customize", profile, viewer: login, accounts: [], repos: [], org: login, credits: 0, autoTopUp: false, currentPlan: null, billing: false };
  const account = useRef<AccountModel>(null!);
  account.current = { profile, login, items: live.items, jobs: live.jobs, state: live.state };
  const [painters] = useState(() => ({ customize: recruitPainter(model), account: accountPainter(account, signals) }));
  const [paint] = useState<{ current: Painter | null }>(() => ({ current: null }));
  paint.current = editing ? painters.customize : painters.account;

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
  const keys = useRef({ save, close, open, editing, admin, radio, sounds, setDrawer });
  keys.current = { save, close, open, editing, admin, radio, sounds, setDrawer };
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
      } else if (!k.editing && k.sounds.supported && (event.key === "k" || event.key === "K") && !typing && !(at instanceof HTMLTextAreaElement)) {
        event.preventDefault();
        k.sounds.toggle();
      } else if (!k.editing && (event.key === "l" || event.key === "L") && !typing && !(at instanceof HTMLTextAreaElement)) {
        event.preventDefault();
        k.setDrawer((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const working = live.jobs.some((j) => j.status !== "queued");
  const doing = nowDoing(live.jobs);

  // At rest: side on against the screen's glow where there's width for it; face to face on a tall phone screen.
  const shot: ShotName = editing && look >= 0 ? LOOKS[look]!.shot : wide ? "preview" : "hood";
  const phosphor = swatch(PHOSPHORS, profile.phosphor).color;

  return (
    <section className="hq-stage" data-editing={editing || undefined} data-feed={(!editing && drawer) || undefined} style={{ "--phosphor": phosphor } as CSSProperties} aria-labelledby="hq-name">
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
        <>
          <div className="hq-top">
            <div className="hq-id">
              <p className="hq-of">{login}’s hacker</p>
              <h1 id="hq-name" className="hq-name">
                {profile.handle}
                <span className="hq-presence" data-working={working || undefined} title={working ? "Working" : "Off duty"} aria-hidden="true" />
              </h1>
              <p className="hq-now" aria-live="polite">
                {doing}
              </p>
            </div>
            <div className="hq-corner">
              <p className="hq-onair" data-state={live.state}>
                <span className="hq-onair-dot" aria-hidden="true" />
                {live.state === "live" ? "Live" : live.state === "connecting" ? "Reconnecting" : "Offline"}
              </p>
              <div className="hq-tools">
                <SoundMenu radio={radio} keys={sounds} />
                {admin && (
                  <button ref={edit} type="button" className="cap-key" onClick={open} data-track="hacker-customize-open">
                    <span className="cap-key-face">
                      Customize <Keycap>C</Keycap>
                    </span>
                  </button>
                )}
              </div>
            </div>
          </div>
          <FeedDrawer open={drawer} onToggle={() => setDrawer((o) => !o)} items={live.items} jobs={live.jobs} record={record} login={login} handle={profile.handle} crew={crew} demo={demo} admin={admin} />
        </>
      )}
    </section>
  );
}

const DRAWER_KEY = "sandchest:hacker-feed";

/** Whether the feed drawer is up, remembered on this browser. */
function useDrawer(): [boolean, (update: (open: boolean) => boolean) => void] {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    try {
      setOpen(localStorage.getItem(DRAWER_KEY) === "open");
    } catch {
      // Down, then.
    }
  }, []);
  const set = (update: (open: boolean) => boolean) =>
    setOpen((current) => {
      const next = update(current);
      try {
        localStorage.setItem(DRAWER_KEY, next ? "open" : "closed");
      } catch {
        // Not remembered, then.
      }
      return next;
    });
  return [open, set];
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

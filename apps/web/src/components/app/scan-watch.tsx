"use client";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { HackerMark } from "@/components/hacker/hacker-mark";
import { Keycap } from "@/components/hacker/keycap";
import { livePainter, type LiveModel } from "@/components/rig/paint-live";
import { RigView } from "@/components/rig/rig-view";
import type { Painter } from "@/components/rig/screen";
import type { ShotName } from "@/components/rig/shots";
import { newSignals } from "@/components/rig/signals";
import { plural, SCAN_KIND_LABEL } from "@/lib/format";
import { PHOSPHORS, swatch, type HackerProfile } from "@/lib/hacker";
import { TRACKS, trackStates } from "@/lib/scan-progress";
import { HoverLink } from "./hover-link";
import { useLive } from "./scan-live";

const ACTIVE = new Set(["queued", "running", "publishing"]);
const HIDDEN_KEY = "sandchest:watch";

/**
 * The scan as the hacker's own screen, over their shoulder. Fed by the same
 * live feed as the log below it, which stays the readable record: this is
 * only the view. Drag to look around the room; C looks closer, F goes full
 * screen, H hides it (and it stays hidden on this browser). The hacker's
 * name opens their page, where they're customized.
 */
export function ScanWatch({ profile, repo, findings, hackerHref }: { profile: HackerProfile; repo: string; findings: number; hackerHref: string | null }) {
  const live = useLive();
  const [hidden, setHidden] = useState<boolean | null>(null);
  const [shot, setShot] = useState<ShotName>("watch");
  const [full, setFull] = useState(false);
  const [dragged, setDragged] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const signals = useRef(newSignals());
  const states = trackStates(live.kind, live.status, live.events.map((e) => e.type));
  const steps = TRACKS[live.kind] ?? [];
  const track = steps.map((step, i) => ({ label: step.label, state: states[i] ?? "pending" }));
  const active = ACTIVE.has(live.status);
  const now = track.find((step) => step.state === "current");
  const found = active ? live.events.filter((e) => e.type === "finding").length : findings;

  const next: LiveModel = {
    profile,
    repo: repo.split("/").pop() ?? repo,
    kind: (SCAN_KIND_LABEL[live.kind] ?? live.kind).toLowerCase(),
    status: live.status,
    origin: live.startedAt ?? live.createdAt,
    finishedAt: live.finishedAt,
    lines: live.events,
    track,
    // Live, count the feed's finding lines; once finished, the scan's own count.
    findings: found,
  };
  const model = useRef<LiveModel>(next);
  useEffect(() => {
    model.current = next;
  });
  const [paint] = useState<{ current: Painter | null }>(() => ({ current: livePainter(model, signals) }));

  useEffect(() => setHidden(localStorage.getItem(HIDDEN_KEY) === "off"), []);
  useEffect(() => {
    const change = () => setFull(document.fullscreenElement === box.current && !!box.current);
    document.addEventListener("fullscreenchange", change);
    return () => document.removeEventListener("fullscreenchange", change);
  }, []);
  const hide = (value: boolean) => {
    setHidden(value);
    if (value) localStorage.setItem(HIDDEN_KEY, "off");
    else localStorage.removeItem(HIDDEN_KEY);
  };
  const fullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void box.current?.requestFullscreen?.();
  };
  const closer = () => setShot((s) => (s === "screen" ? "watch" : "screen"));

  // The keys on the caps, from anywhere on the page that isn't a field.
  const keys = useRef({ closer, fullscreen, hide, hidden });
  keys.current = { closer, fullscreen, hide, hidden };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
      const at = document.activeElement;
      if (at instanceof HTMLInputElement || at instanceof HTMLTextAreaElement || at instanceof HTMLSelectElement || (at instanceof HTMLElement && at.isContentEditable)) return;
      const k = keys.current;
      const key = event.key.toLowerCase();
      if (k.hidden) {
        if (key === "h") k.hide(false);
        return;
      }
      if (key === "c") k.closer();
      else if (key === "f") k.fullscreen();
      else if (key === "h") k.hide(true);
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (hidden === null) return <div className="watch-placeholder" />;
  if (hidden)
    return (
      <div className="watch-off">
        <button type="button" className="cap-key" onClick={() => hide(false)}>
          <span className="cap-key-face">
            <HackerMark profile={profile} size={18} />
            Watch {profile.handle}’s screen <Keycap>H</Keycap>
          </span>
        </button>
      </div>
    );

  const who = (
    <>
      <HackerMark profile={profile} size={30} className="watch-mark" />
      <strong>{profile.handle}</strong>
    </>
  );
  return (
    <div ref={box} className="watch" data-live={active ? undefined : "off"} style={{ "--phosphor": swatch(PHOSPHORS, profile.phosphor).color } as CSSProperties}>
      <div className="watch-scene" onPointerDown={() => setDragged(true)}>
        <RigView profile={profile} org={repo.split("/")[0] ?? repo} shot={shot} paint={paint} signals={signals} drag="look" poster />
      </div>
      <div className="watch-bar">
        <p className="watch-who">
          {hackerHref ? (
            <HoverLink href={hackerHref} className="watch-name" title={`${profile.handle}’s page`}>
              {who}
            </HoverLink>
          ) : (
            <span className="watch-name">{who}</span>
          )}
          <span className="watch-doing">
            <span className="watch-dot" aria-hidden="true" />
            {live.status === "queued" ? "Waiting to start on" : active ? "Working on" : "Worked on"} {repo}
          </span>
        </p>
        <span className="watch-tools">
          <button type="button" className="cap-key cap-key-small" aria-pressed={shot === "screen"} onClick={closer} aria-label={shot === "screen" ? "Step back" : "Look closer"}>
            <span className="cap-key-face">
              <LensIcon />
              <span className="cap-key-label">{shot === "screen" ? "Step back" : "Look closer"}</span>
              <Keycap>C</Keycap>
            </span>
          </button>
          <button type="button" className="cap-key cap-key-small" aria-pressed={full} onClick={fullscreen} aria-label={full ? "Leave full screen" : "Full screen"}>
            <span className="cap-key-face">
              <FullIcon />
              <span className="cap-key-label">{full ? "Exit" : "Full screen"}</span>
              <Keycap>F</Keycap>
            </span>
          </button>
          <button type="button" className="cap-key cap-key-small" onClick={() => hide(true)} aria-label="Hide the view">
            <span className="cap-key-face">
              <HideIcon />
              <span className="cap-key-label">Hide</span>
              <Keycap>H</Keycap>
            </span>
          </button>
        </span>
      </div>
      <div className="watch-hud" aria-hidden="true">
        {steps.length > 0 && (
          <span className="watch-quest">
            <span className="watch-steps">
              {track.map((step, i) => (
                <i key={i} data-state={step.state} />
              ))}
            </span>
            <span className="watch-step">{now ? now.label : live.status === "queued" ? "Queued" : active ? "Starting" : "Done"}</span>
          </span>
        )}
        <span className="watch-found" data-some={found > 0 || undefined}>
          {plural(found, "find")}
        </span>
        <span className="watch-hint" data-gone={dragged || undefined}>
          Drag to look around
        </span>
      </div>
    </div>
  );
}

function LensIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 7 7" shapeRendering="crispEdges" aria-hidden="true">
      <path fill="currentColor" d="M1 0h3v1H1zM0 1h1v3H0zM4 1h1v3H4zM1 4h3v1H1zM4 4h1v1H4zM5 5h1v1H5zM6 6h1v1H6z" />
    </svg>
  );
}

function FullIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 7 7" shapeRendering="crispEdges" aria-hidden="true">
      <path fill="currentColor" d="M0 0h3v1H1v2H0zM4 0h3v3H6V1H4zM0 4h1v2h2v1H0zM6 4h1v3H4V6h2z" />
    </svg>
  );
}

function HideIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 7 7" shapeRendering="crispEdges" aria-hidden="true">
      <path fill="currentColor" d="M0 0h1v1H0zM1 1h1v1H1zM2 2h1v1H2zM3 3h1v1H3zM4 4h1v1H4zM5 5h1v1H5zM6 6h1v1H6zM2 1h3v1H2zM5 2h1v1H5zM6 3h1v1H6zM0 3h1v1H0zM1 4h1v1H1zM2 5h3v1H2z" />
    </svg>
  );
}

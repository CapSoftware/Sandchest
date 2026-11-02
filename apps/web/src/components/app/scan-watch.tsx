"use client";
import Link from "next/link";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { livePainter, type LiveModel } from "@/components/rig/paint-live";
import { RigView } from "@/components/rig/rig-view";
import type { Painter } from "@/components/rig/screen";
import type { ShotName } from "@/components/rig/shots";
import { newSignals } from "@/components/rig/signals";
import { SCAN_KIND_LABEL } from "@/lib/format";
import { PHOSPHORS, swatch, type HackerProfile } from "@/lib/hacker";
import { TRACKS, trackStates } from "@/lib/scan-progress";
import { useLive } from "./scan-live";

const ACTIVE = new Set(["queued", "running", "publishing"]);
const HIDDEN_KEY = "sandchest:watch";

/**
 * The scan as the hacker's own screen, over its shoulder. Fed by the same
 * live feed as the log below it, which stays the readable record: this is
 * only the view. It can be hidden, and stays hidden on this browser.
 */
export function ScanWatch({ profile, repo, findings, recruitHref, recruited }: { profile: HackerProfile; repo: string; findings: number; recruitHref: string | null; recruited: boolean }) {
  const live = useLive();
  const [hidden, setHidden] = useState<boolean | null>(null);
  const [shot, setShot] = useState<ShotName>("watch");
  const box = useRef<HTMLDivElement>(null);
  const signals = useRef(newSignals());
  const states = trackStates(live.kind, live.status, live.events.map((e) => e.type));
  const track = (TRACKS[live.kind] ?? []).map((step, i) => ({ label: step.label, state: states[i] ?? "pending" }));
  const active = ACTIVE.has(live.status);

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
    findings: active ? live.events.filter((e) => e.type === "finding").length : findings,
  };
  const model = useRef<LiveModel>(next);
  useEffect(() => {
    model.current = next;
  });
  const [paint] = useState<{ current: Painter | null }>(() => ({ current: livePainter(model, signals) }));

  useEffect(() => setHidden(localStorage.getItem(HIDDEN_KEY) === "off"), []);
  const hide = (value: boolean) => {
    setHidden(value);
    if (value) localStorage.setItem(HIDDEN_KEY, "off");
    else localStorage.removeItem(HIDDEN_KEY);
  };
  const fullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void box.current?.requestFullscreen?.();
  };

  if (hidden === null) return <div className="watch-placeholder" />;
  if (hidden)
    return (
      <div className="watch-off">
        <button type="button" onClick={() => hide(false)}>
          Watch {profile.handle}’s screen
        </button>
      </div>
    );

  return (
    <div ref={box} className="watch" data-live={active ? undefined : "off"} style={{ "--phosphor": swatch(PHOSPHORS, profile.phosphor).color } as CSSProperties}>
      <RigView profile={profile} org={repo.split("/")[0] ?? repo} shot={shot} paint={paint} signals={signals} poster />
      <div className="watch-bar">
        <p className="watch-who">
          <span className="watch-dot" aria-hidden="true" />
          <strong>{profile.handle}</strong>
          <span>
            {live.status === "queued" ? "is waiting to start on" : active ? "is working on" : "worked on"} {repo}
          </span>
        </p>
        <span className="watch-tools">
          <button type="button" aria-pressed={shot === "screen"} onClick={() => setShot(shot === "screen" ? "watch" : "screen")}>
            {shot === "screen" ? "Step back" : "Look closer"}
          </button>
          <button type="button" onClick={fullscreen}>
            Full screen
          </button>
          {recruitHref && <Link href={recruitHref}>{recruited ? "Change hacker" : "Recruit yours"}</Link>}
          <button type="button" onClick={() => hide(true)}>
            Hide
          </button>
        </span>
      </div>
    </div>
  );
}

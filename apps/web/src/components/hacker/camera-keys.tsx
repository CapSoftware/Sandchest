"use client";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { CameraControl, CameraPose } from "@/components/rig/rig-scene";
import type { ShotName } from "@/components/rig/shots";
import { Keycap } from "./keycap";
import "./sound-menu.css";

/** The angles there always are. Room is where the page opens the first time. */
export const PRESETS = [
  { id: "room", label: "Room" },
  { id: "work", label: "Screen and keys" },
  { id: "hands", label: "Hands" },
  { id: "face", label: "Face" },
] as const;

type PresetId = (typeof PRESETS)[number]["id"];

/** A view someone saved: a shot, and where they'd turned and zoomed from it. */
export interface SavedView {
  id: string;
  label: string;
  shot: ShotName;
  pose: CameraPose;
}

/** Where the camera is: a preset or saved view (if it was chosen and not moved since), its shot and the pose from it. */
interface Current {
  chosen: string;
  shot: ShotName;
  pose: CameraPose;
}

const KEY = "sandchest:hacker-camera";
const MAX_SAVED = 6;
const STILL: CameraPose = { around: 0, up: 0, zoom: 1 };

/** A preset's shot: the room side on where there's width for it, face to face on a tall phone screen. */
function presetShot(id: PresetId, wide: boolean): ShotName {
  if (id === "room") return wide ? "preview" : "hood";
  if (id === "face") return "hood";
  return id;
}

const moved = (pose: CameraPose) => Math.abs(pose.around) > 1e-3 || Math.abs(pose.up) > 1e-3 || Math.abs(pose.zoom - 1) > 1e-3;

export interface CameraViews {
  shot: ShotName;
  chosen: string | null;
  saved: SavedView[];
  /** Whether the camera is away from where the page opens the first time. */
  away: boolean;
  /** Whether it's been dragged or zoomed from the view chosen: there's something new to save. */
  dragged: boolean;
  /** The name of the view showing. */
  label: string;
  /** The next view along: the angles, then the views saved here, then round again. */
  next: () => void;
  choose: (id: string) => void;
  save: () => void;
  remove: (id: string) => void;
  reset: () => void;
}

/**
 * The hacker page's camera: preset angles, views people save, and the camera
 * where they left it, all remembered on this browser. Dragging and zooming
 * (the scene's free look) moves it from whichever view was chosen; that
 * pose is what's saved and remembered.
 */
export function useCameraViews(camera: RefObject<CameraControl | null>, wide: boolean): CameraViews {
  const [current, setCurrent] = useState<Current>({ chosen: "room", shot: presetShot("room", wide), pose: STILL });
  const [saved, setSaved] = useState<SavedView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [away, setAway] = useState(false);
  const [dragged, setDragged] = useState(false);
  const latest = useRef({ current, saved });
  latest.current = { current, saved };

  // Puts the camera there as soon as the scene can take it (it loads after the page).
  const place = useCallback(
    (shot: ShotName, pose: CameraPose) => {
      let tries = 0;
      const attempt = () => {
        if (camera.current) return camera.current.set(shot, pose);
        if (tries++ < 120) window.setTimeout(attempt, 250);
      };
      attempt();
    },
    [camera],
  );

  const persist = useCallback((next: { current: Current; saved: SavedView[] }) => {
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // Not remembered, then.
    }
  }, []);

  // Where it was left last time.
  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(KEY) ?? "null") as { current?: Current; saved?: SavedView[] } | null;
      if (stored?.saved && Array.isArray(stored.saved)) setSaved(stored.saved.slice(0, MAX_SAVED));
      if (stored?.current?.shot && stored.current.pose) {
        // A preset follows the screen it's opened on (the room side on, or face to face on a phone).
        const preset = PRESETS.find((p) => p.id === stored.current!.chosen);
        const shot = preset ? presetShot(preset.id, wide) : stored.current.shot;
        setCurrent({ ...stored.current, shot });
        place(shot, stored.current.pose);
      }
    } catch {
      // Nothing usable stored: the room it is.
    }
    setLoaded(true);
    // Once, on arrival; the width's own changes are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The room preset turns side on or face to face as the window's width changes.
  useEffect(() => {
    if (!loaded) return;
    setCurrent((c) => (c.chosen === "room" ? { ...c, shot: presetShot("room", wide) } : c));
  }, [wide, loaded]);

  // Keep where the camera actually is (dragged, zoomed) every few seconds and on leaving, so it reopens there.
  useEffect(() => {
    const remember = () => {
      const pose = camera.current?.pose();
      if (!pose) return;
      const c = latest.current.current;
      const changed = Math.abs(pose.around - c.pose.around) > 1e-3 || Math.abs(pose.up - c.pose.up) > 1e-3 || Math.abs(pose.zoom - c.pose.zoom) > 1e-3;
      const isAway = c.chosen !== "room" || moved(pose);
      setAway(isAway);
      // Moved from the chosen view's own pose (a preset's is still; a saved one's is its own).
      const base = latest.current.saved.find((v) => v.id === c.chosen)?.pose ?? STILL;
      setDragged(Math.abs(pose.around - base.around) > 0.02 || Math.abs(pose.up - base.up) > 0.02 || Math.abs(pose.zoom - base.zoom) > 0.02);
      if (!changed) return;
      const next = { ...c, pose, chosen: c.chosen };
      latest.current.current = next;
      persist({ current: next, saved: latest.current.saved });
    };
    const timer = window.setInterval(remember, 1500);
    window.addEventListener("pagehide", remember);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("pagehide", remember);
    };
  }, [camera, persist]);

  const choose = useCallback(
    (id: string) => {
      const preset = PRESETS.find((p) => p.id === id);
      const view = preset ? { chosen: id, shot: presetShot(preset.id, wide), pose: STILL } : (() => {
        const s = latest.current.saved.find((v) => v.id === id);
        return s ? { chosen: s.id, shot: s.shot, pose: s.pose } : null;
      })();
      if (!view) return;
      setCurrent(view);
      setAway(view.chosen !== "room" || moved(view.pose));
      setDragged(false);
      place(view.shot, view.pose);
      persist({ current: view, saved: latest.current.saved });
    },
    [wide, place, persist],
  );

  const save = useCallback(() => {
    const pose = camera.current?.pose() ?? latest.current.current.pose;
    const all = latest.current.saved;
    const n = all.reduce((max, v) => Math.max(max, Number(v.label.replace(/\D/g, "")) || 0), 0) + 1;
    const view: SavedView = { id: `view-${Date.now().toString(36)}`, label: `View ${n}`, shot: latest.current.current.shot, pose };
    const next = [...all, view].slice(-MAX_SAVED);
    setSaved(next);
    const current = { chosen: view.id, shot: view.shot, pose };
    setCurrent(current);
    setDragged(false);
    persist({ current, saved: next });
  }, [camera, persist]);

  const remove = useCallback(
    (id: string) => {
      const next = latest.current.saved.filter((v) => v.id !== id);
      setSaved(next);
      const current = latest.current.current.chosen === id ? { ...latest.current.current, chosen: "" } : latest.current.current;
      setCurrent(current);
      persist({ current, saved: next });
    },
    [persist],
  );

  const reset = useCallback(() => choose("room"), [choose]);

  const next = useCallback(() => {
    const order = [...PRESETS.map((p) => p.id as string), ...latest.current.saved.map((v) => v.id)];
    const at = order.indexOf(latest.current.current.chosen);
    choose(order[(at + 1) % order.length]!);
  }, [choose]);

  const label = PRESETS.find((p) => p.id === current.chosen)?.label ?? saved.find((v) => v.id === current.chosen)?.label ?? "Your view";

  return { shot: current.shot, chosen: current.chosen || null, saved, away, dragged, label, next, choose, save, remove, reset };
}

/**
 * The camera, as one key: each press (or V) moves to the next view, the
 * angles first and then the views saved here, and the key says which view
 * it is. Small keys beside it only when they apply: save the view after a
 * drag or zoom, forget a saved view while it shows, and straight back to the
 * default when away from it.
 */
export function CameraKeys({ views }: { views: CameraViews }) {
  const saved = views.saved.find((v) => v.id === views.chosen);
  return (
    <div className="camera-keys" role="group" aria-label="Camera">
      {views.away && (
        <button type="button" className="cap-key cap-key-icon" onClick={views.reset} aria-label="Back to the default view" title="Back to the default view" data-track="hacker-camera-default">
          <span className="cap-key-face">
            <ResetIcon />
          </span>
        </button>
      )}
      {views.dragged ? (
        <button type="button" className="cap-key cap-key-icon" onClick={views.save} aria-label="Save this view" title="Save this view" data-track="hacker-camera-save">
          <span className="cap-key-face">
            <PlusIcon />
          </span>
        </button>
      ) : (
        saved && (
          <button type="button" className="cap-key cap-key-icon" onClick={() => views.remove(saved.id)} aria-label={`Forget ${saved.label}`} title={`Forget ${saved.label}`} data-track="hacker-camera-forget">
            <span className="cap-key-face">
              <CrossIcon />
            </span>
          </button>
        )
      )}
      <button type="button" className="cap-key" onClick={views.next} aria-label={`Camera: ${views.label}. Next view`} data-track="hacker-camera-next">
        <span className="cap-key-face">
          <CameraIcon />
          <span className="cap-key-label">{views.label}</span>
          <Keycap>V</Keycap>
        </span>
      </button>
    </div>
  );
}

function CameraIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 7 7" shapeRendering="crispEdges" aria-hidden="true">
      <path fill="currentColor" d="M0 2h5v1H0zM0 5h5v1H0zM0 3h1v2H0zM4 3h1v2H4zM2 3h1v2H2zM5 3h1v2H5zM6 2h1v4H6z" />
    </svg>
  );
}

function ResetIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 7 7" shapeRendering="crispEdges" aria-hidden="true">
      <path fill="currentColor" d="M2 0h4v1H2zM1 1h1v1H1zM0 2h1v3H0zM1 5h1v1H1zM2 6h4v1H2zM6 1h1v1H6zM5 2h2v1H5zM6 5h1v1H6z" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 5 5" shapeRendering="crispEdges" aria-hidden="true">
      <path fill="currentColor" d="M2 0h1v5H2zM0 2h5v1H0z" />
    </svg>
  );
}

function CrossIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 5 5" shapeRendering="crispEdges" aria-hidden="true">
      <path fill="currentColor" d="M0 0h1v1H0zM1 1h1v1H1zM2 2h1v1H2zM3 3h1v1H3zM4 4h1v1H4zM4 0h1v1H4zM3 1h1v1H3zM1 3h1v1H1zM0 4h1v1H0z" />
    </svg>
  );
}

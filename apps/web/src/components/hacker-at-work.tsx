"use client";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { demoPainter } from "@/components/rig/paint-demo";
import { RigView } from "@/components/rig/rig-view";
import type { Painter } from "@/components/rig/screen";
import type { ShotName } from "@/components/rig/shots";
import { newSignals } from "@/components/rig/signals";
import { DEFAULT_HACKER } from "@/lib/hacker";

/**
 * The hacker at the desk in the bunker, closing the landing page: running
 * a made-up deep scan of a placeholder repository, and when it finds
 * something the camera leans in past the hacker's arm and the chest is hacked
 * open on the screen. Dragging looks around the room. The band stays dark
 * until it comes near; only then do the scene and its files load, on
 * machines that can draw it. `children` float over the top of the room.
 */
export function HackerAtWork({ children }: { children?: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const signals = useRef(newSignals());
  const paint = useRef<Painter | null>(null);
  const [near, setNear] = useState(false);
  const [shot, setShot] = useState<ShotName>("preview");

  useEffect(() => {
    const node = box.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        setNear(true);
        observer.disconnect();
      },
      { rootMargin: "100% 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (near) paint.current = demoPainter(DEFAULT_HACKER, signals, (found) => setShot(found ? "lean" : "preview"));
  }, [near]);

  return (
    <div ref={box} className="hacker-at-work">
      {near ? (
        <RigView profile={DEFAULT_HACKER} org="acme" shot={shot} paint={paint} signals={signals} opening="landing" poster drag />
      ) : (
        <div className="rig" />
      )}
      <p className="hacker-hint" aria-hidden="true">Drag to look around</p>
      {children && <div className="hacker-over">{children}</div>}
    </div>
  );
}

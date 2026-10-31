"use client";

import { type ReactNode, useEffect, useRef } from "react";

/**
 * A list item that plays its CSS animations once, the first time it is mostly
 * on screen, by setting `data-play`. Animations only run under
 * `html[data-motion]`; otherwise the final state shows from the start.
 */
export function PlayOnView({ className, children }: { className: string; children: ReactNode }) {
  const ref = useRef<HTMLLIElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        el.dataset.play = "";
        observer.disconnect();
      },
      // Low enough to trigger even when the step is taller than the screen.
      { threshold: 0.35 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <li ref={ref} className={`play ${className}`}>
      {children}
    </li>
  );
}

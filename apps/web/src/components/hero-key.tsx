"use client";

import { useEffect, useRef } from "react";
import { createKeyFire } from "@/lib/key-fire";

/** Screen pixels per grid cell, the same as the chest panel. */
const CELL = 2;
/** Room around the key for the fire, in pixels. */
const PAD = { x: 24, top: 72, bottom: 16 };

/**
 * The hero's gold key. On hover or focus it catches fire on the chest's
 * dithered grid. Without JavaScript, or with reduced motion, it is the plain key.
 */
export function HeroKey({ href, children }: { href: string; children: React.ReactNode }) {
  const linkRef = useRef<HTMLAnchorElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const link = linkRef.current;
    const canvas = canvasRef.current;
    if (!link || !canvas || !document.documentElement.hasAttribute("data-motion")) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let fire: ReturnType<typeof createKeyFire> | null = null;
    let image: ImageData | null = null;
    let hot = false;
    let raf = 0;
    let last = 0;

    const layout = () => {
      const cols = Math.round((link.offsetWidth + PAD.x * 2) / CELL);
      const rows = Math.round((link.offsetHeight + PAD.top + PAD.bottom) / CELL);
      canvas.width = cols;
      canvas.height = rows;
      canvas.style.width = `${cols * CELL}px`;
      canvas.style.height = `${rows * CELL}px`;
      image = ctx.createImageData(cols, rows);
      fire = createKeyFire(cols, rows, {
        x: PAD.x / CELL,
        y: PAD.top / CELL,
        w: Math.round(link.offsetWidth / CELL),
        h: Math.round(link.offsetHeight / CELL),
      });
    };

    const frame = (now: number) => {
      if (!fire || !image) return;
      const alive = fire.step(Math.min(0.05, (now - last) / 1000), hot);
      last = now;
      fire.render(image.data);
      ctx.putImageData(image, 0, 0);
      raf = alive ? requestAnimationFrame(frame) : 0;
    };

    const light = () => {
      hot = true;
      if (!raf) {
        last = performance.now();
        raf = requestAnimationFrame(frame);
      }
    };
    const douse = () => {
      hot = false;
    };

    layout();
    const resize = new ResizeObserver(layout);
    resize.observe(link);
    link.addEventListener("pointerenter", light);
    link.addEventListener("pointerleave", douse);
    link.addEventListener("focus", light);
    link.addEventListener("blur", douse);
    return () => {
      cancelAnimationFrame(raf);
      resize.disconnect();
      link.removeEventListener("pointerenter", light);
      link.removeEventListener("pointerleave", douse);
      link.removeEventListener("focus", light);
      link.removeEventListener("blur", douse);
    };
  }, []);

  return (
    <a ref={linkRef} href={href} className="button button-primary button-hero">
      <canvas ref={canvasRef} className="key-fire" width={0} height={0} aria-hidden="true" style={{ left: -PAD.x, top: -PAD.top }} />
      <span className="button-face">{children}</span>
    </a>
  );
}

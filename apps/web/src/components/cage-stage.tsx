"use client";

import { useEffect, useRef } from "react";
import { CAGE_ROWS, createCageScene, type Hits, type Wall } from "@/lib/cage-dither";

const FRAME_MS = 1000 / 30;
const WALLS: Wall[] = ["top", "left", "right"];

type Scene = ReturnType<typeof createCageScene>;

/**
 * The sandbox in its panel, with the walls labelled. While on screen the
 * model kicks sand at the walls, and a wall's label lights up each time a
 * grain hits it; off screen it pauses. With reduced motion it draws the
 * settled pile once. Decorative: the bullets under it say the same in words.
 */
export function CageStage() {
  const stageRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelRefs = useRef<Partial<Record<Wall, HTMLSpanElement | null>>>({});

  useEffect(() => {
    const stage = stageRef.current;
    const sceneEl = sceneRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!stage || !sceneEl || !canvas || !ctx) return;

    const animate = document.documentElement.hasAttribute("data-motion");
    let scene: Scene | null = null;
    let image: ImageData | null = null;
    let raf = 0;
    let visible = false;
    let lastDraw = 0;
    const lit: Hits = { top: false, left: false, right: false };

    const draw = () => {
      if (!scene || !image) return;
      const hits = scene.render(image.data);
      ctx.putImageData(image, 0, 0);
      for (const wall of WALLS) {
        if (hits[wall] === lit[wall]) continue;
        lit[wall] = hits[wall];
        labelRefs.current[wall]?.toggleAttribute("data-hit", hits[wall]);
      }
    };

    /** Sizes the grid to the panel, in whole cells so pixels stay crisp. */
    const layout = () => {
      const cell = Number.parseFloat(getComputedStyle(stage).getPropertyValue("--cell")) || 3;
      const cols = Math.ceil(sceneEl.clientWidth / cell);
      if (cols < 1) return;
      if (!image || image.width !== cols) {
        canvas.width = cols;
        canvas.height = CAGE_ROWS;
        image = ctx.createImageData(cols, CAGE_ROWS);
        scene = createCageScene(cols, CAGE_ROWS);
      }
      canvas.style.width = `${cols * cell}px`;
      canvas.style.height = `${CAGE_ROWS * cell}px`;
      canvas.style.left = `${Math.round((sceneEl.clientWidth - cols * cell) / 2)}px`;
      draw();
      stage.dataset.canvas = "ready";
    };

    const tick = (now: number) => {
      raf = 0;
      if (!visible) return;
      raf = requestAnimationFrame(tick);
      if (now - lastDraw < FRAME_MS - 1) return;
      // Capped, so coming back on screen doesn't throw the sand across the box.
      const dt = lastDraw ? Math.min(0.05, (now - lastDraw) / 1000) : 0;
      lastDraw = now;
      scene?.step(dt);
      draw();
    };

    const observer = new IntersectionObserver(([entry]) => {
      visible = !!entry?.isIntersecting;
      if (animate && visible && !raf) raf = requestAnimationFrame(tick);
    });

    let resizeFrame = 0;
    const resizeObserver = new ResizeObserver(() => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(layout);
    });

    layout();
    resizeObserver.observe(sceneEl);
    if (animate) observer.observe(sceneEl);

    return () => {
      cancelAnimationFrame(raf);
      cancelAnimationFrame(resizeFrame);
      resizeObserver.disconnect();
      observer.disconnect();
    };
  }, []);

  const label = (wall: Wall, text: string) => (
    <span
      ref={(el) => {
        labelRefs.current[wall] = el;
      }}
      className={`cage-label cage-${wall}`}
    >
      <span className="cage-x" />
      {text}
    </span>
  );

  return (
    <div ref={stageRef} className="cage-stage" aria-hidden="true">
      <div ref={sceneRef} className="cage-scene">
        <canvas ref={canvasRef} className="cage-canvas" />
        {label("top", "can’t push")}
        {label("left", "no network")}
        {label("right", "no shell")}
        <span className="cage-label cage-floor">reads your code, nothing else</span>
      </div>
    </div>
  );
}

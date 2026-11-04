"use client";

import { useEffect, useRef } from "react";
import { CALM_AT, createChestScene, SPRITE_H, SPRITE_W, STEADY_AT } from "@/lib/chest-dither";

/** Pause between the chest coming into view and the hack starting. */
const WAIT_S = 0.4;
const SEQUENCE_FRAME_MS = 1000 / 60;
/** Once only the sand moves, it doesn't need full frame rate. */
const CALM_FRAME_MS = 1000 / 30;

type Scene = ReturnType<typeof createChestScene>;

/**
 * The dithered chest in its panel. Once on screen the lock is picked and
 * sand runs out of the keyhole, filling the floor until the pile is full;
 * after that the stream keeps running into it. It pauses whenever the panel
 * is off screen.
 *
 * Without JavaScript a static image of the finished scene is shown. With
 * reduced motion that frame is drawn once.
 */
export function ChestStage() {
  const stageRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const stage = stageRef.current;
    const sceneEl = sceneRef.current;
    const canvas = canvasRef.current;
    if (!stage || !sceneEl || !canvas) return;

    const animate = document.documentElement.hasAttribute("data-motion");
    const fail = () => {
      stage.dataset.canvas = "failed";
    };

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      fail();
      return;
    }

    let disposed = false;
    let raf = 0;
    let visible = false;
    let lastDraw = 0;
    const epoch = performance.now();
    /** Seconds after epoch at which the hack starts. */
    let startAt = animate ? Number.POSITIVE_INFINITY : -STEADY_AT - 1;
    let sprite: ImageData | null = null;
    let renderer: Scene | null = null;
    let image: ImageData | null = null;

    const draw = (now: number) => {
      if (!renderer || !image) return;
      const clock = (now - epoch) / 1000;
      const since = clock - startAt;
      renderer.render(image.data, clock, Number.isFinite(since) ? since : -1);
      ctx.putImageData(image, 0, 0);
    };

    /** Sizes the grid to the panel, in whole cells so pixels stay crisp. */
    const layout = () => {
      if (!sprite) return;
      const cell = Number.parseFloat(getComputedStyle(stage).getPropertyValue("--cell")) || 3;
      const cols = Math.ceil(sceneEl.clientWidth / cell);
      const rows = Math.round(sceneEl.clientHeight / cell);
      if (cols < 1 || rows < 1) return;
      if (!image || image.width !== cols || image.height !== rows) {
        canvas.width = cols;
        canvas.height = rows;
        image = ctx.createImageData(cols, rows);
        renderer = createChestScene(sprite, cols, rows);
      }
      canvas.style.width = `${cols * cell}px`;
      canvas.style.height = `${rows * cell}px`;
      canvas.style.left = `${Math.round((sceneEl.clientWidth - cols * cell) / 2)}px`;
      draw(performance.now());
    };

    const tick = (now: number) => {
      raf = 0;
      // Not started yet: the frame from layout() stands, and start() wakes us.
      if (disposed || !visible || startAt === Number.POSITIVE_INFINITY) return;
      raf = requestAnimationFrame(tick);
      const since = (now - epoch) / 1000 - startAt;
      const budget = since < CALM_AT ? SEQUENCE_FRAME_MS : CALM_FRAME_MS;
      if (since < 0 || now - lastDraw < budget - 1) return;
      lastDraw = now;
      draw(now);
    };

    const wake = () => {
      if (animate && !raf && visible && renderer) raf = requestAnimationFrame(tick);
    };

    const start = (delay: number) => {
      if (startAt === Number.POSITIVE_INFINITY) {
        startAt = (performance.now() - epoch) / 1000 + delay;
        wake();
      }
    };

    const sceneObserver = new IntersectionObserver(
      ([entry]) => {
        visible = entry.isIntersecting;
        if (entry.intersectionRatio >= 0.6) start(WAIT_S);
        wake();
      },
      { threshold: [0, 0.6] },
    );

    let resizeFrame = 0;
    const scheduleLayout = () => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(layout);
    };
    const resizeObserver = new ResizeObserver(scheduleLayout);

    const icon = new Image();
    icon.src = "/sandchest-icon-flat.svg";
    icon
      .decode()
      .then(() => {
        if (disposed) return;
        const spriteCanvas = document.createElement("canvas");
        spriteCanvas.width = SPRITE_W;
        spriteCanvas.height = SPRITE_H;
        const sctx = spriteCanvas.getContext("2d", { willReadFrequently: true });
        if (!sctx) throw new Error("2D canvas unavailable");
        sctx.drawImage(icon, 0, 0, SPRITE_W, SPRITE_H);
        sprite = sctx.getImageData(0, 0, SPRITE_W, SPRITE_H);

        // Paint the first frame before showing the canvas.
        layout();
        stage.dataset.canvas = "ready";

        resizeObserver.observe(sceneEl);
        if (!animate) return;
        sceneObserver.observe(sceneEl);
      })
      .catch(() => {
        if (!disposed) fail();
      });

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      cancelAnimationFrame(resizeFrame);
      resizeObserver.disconnect();
      sceneObserver.disconnect();
    };
  }, []);

  return (
    <div ref={stageRef} className="chest-stage" data-chest-stage="">
      <div ref={sceneRef} className="scene">
        <img className="scene-fallback" src="/chest-dither.png" alt="" decoding="async" />
        <canvas ref={canvasRef} className="scene-canvas" aria-hidden="true" />
      </div>
    </div>
  );
}

"use client";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, type RefObject } from "react";
import { CanvasTexture, Color, Matrix4, MeshPhysicalMaterial, NearestFilter, PlaneGeometry, Quaternion, SRGBColorSpace, Vector3 } from "three";
import { joltAt, type Signals } from "./signals";

/**
 * Where the face is, from the posed rig (FACE in scripts/rig/hacker.py): the
 * point between the eyes, and the head tilted 27° down towards the screen.
 */
const EYES = new Vector3(-0.002, 0.529, 0.274);
const TILT = (27 * Math.PI) / 180;
const FORWARD = new Vector3(0, -Math.sin(TILT), -Math.cos(TILT));
const UP = new Vector3(0, Math.cos(TILT), -Math.sin(TILT));
/** The viewer's right, looking at the face: the visor's texture reads the right way round. */
const RIGHT = new Vector3(-1, 0, 0);

/** The visor: a curved plate of black glass, filling the hood's opening. */
const WIDTH = 0.16;
const HEIGHT = 0.2;
const CENTRE = EYES.clone().addScaledVector(FORWARD, 0.04).addScaledVector(UP, -0.022);
const GLOW = EYES.clone().addScaledVector(FORWARD, 0.06);

/** The face is drawn on a grid of big pixels, like the Sandchest mark. */
const COLUMNS = 20;
const ROWS = 25;
const CELL = 8;
/** Eyes: centred on these cells (from the top left), the width of an eye apart. */
const EYE_ROW = 9;
const EYE_COLUMNS = [6, 14];

type Look = { open: "open" | "wide" | "sleepy" | "blink"; glance: -1 | 0 | 1 };

/** The pixels lit for one eye, centred on (cx, cy), as [column, row] pairs. */
function eyePixels(cx: number, cy: number, look: Look): [number, number][] {
  const x = cx + look.glance;
  const box = (w: number, h: number, trim: boolean): [number, number][] => {
    const cells: [number, number][] = [];
    const left = x - Math.floor(w / 2);
    const top = cy - Math.floor(h / 2);
    for (let i = 0; i < w; i++)
      for (let j = 0; j < h; j++) {
        // Rounded: no corner pixels.
        if (trim && (i === 0 || i === w - 1) && (j === 0 || j === h - 1)) continue;
        cells.push([left + i, top + j]);
      }
    return cells;
  };
  switch (look.open) {
    case "blink":
      return box(4, 1, false).map(([c, r]) => [c, r + 1]);
    case "sleepy":
      return box(4, 2, false).map(([c, r]) => [c, r + 1]);
    case "wide":
      return box(5, 6, true);
    default:
      return box(4, 5, true);
  }
}

function paint(context: CanvasRenderingContext2D, look: Look, colour: string) {
  const canvas = context.canvas;
  context.fillStyle = "#000";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = colour;
  for (const cx of EYE_COLUMNS) for (const [c, r] of eyePixels(cx, EYE_ROW, look)) context.fillRect(c * CELL, r * CELL, CELL, CELL);
}

/** A small, steady hash: the same blink pattern every time. */
function noise(n: number): number {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
}

/** What the eyes are doing at time t. */
function lookAt(t: number, s: Signals | null): Look {
  const found = joltAt(s, t) > 0;
  const typing = (s?.typingUntil ?? 0) > t;
  // A blink every three to six seconds, a tenth of a second long.
  const beat = Math.floor(t / 4.5);
  const blinkAt = beat * 4.5 + noise(beat) * 3;
  const blinking = t >= blinkAt && t < blinkAt + 0.12;
  // Reading: the eyes move across a line, then back.
  const glance: Look["glance"] = typing ? ((Math.floor(t * 2.2) % 3) - 1) as Look["glance"] : 0;
  if (found) return { open: "wide", glance: 0 };
  if (blinking) return { open: "blink", glance };
  if (s?.dim) return { open: "sleepy", glance: 0 };
  return { open: "open", glance };
}

/**
 * The hacker's face: a black glass visor in the hood with two pixel eyes in
 * the screen's colour. They blink, follow the lines while it types, go wide
 * when the scan finds something and droop while it waits.
 */
export function Visor({ colour, signals }: { colour: string; signals: RefObject<Signals> }) {
  const geometry = useMemo(() => {
    const plane = new PlaneGeometry(WIDTH, HEIGHT, 24, 24);
    const position = plane.attributes.position!;
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i) / (WIDTH / 2);
      const y = position.getY(i) / (HEIGHT / 2);
      // Curved like a face: back at the sides, less so top to bottom.
      position.setZ(i, -0.05 * x * x - 0.028 * y * y);
    }
    plane.computeVertexNormals();
    return plane;
  }, []);
  const orientation = useMemo(() => new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(RIGHT, UP, FORWARD)), []);

  const face = useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = COLUMNS * CELL;
    canvas.height = ROWS * CELL;
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    texture.magFilter = NearestFilter;
    texture.minFilter = NearestFilter;
    texture.generateMipmaps = false;
    return { context: canvas.getContext("2d")!, texture, drawn: "" };
  }, []);
  const material = useMemo(
    () =>
      new MeshPhysicalMaterial({
        color: new Color("#030303"),
        roughness: 0.2,
        metalness: 0,
        clearcoat: 1,
        clearcoatRoughness: 0.08,
        emissive: new Color("#ffffff"),
        emissiveMap: face.texture,
        emissiveIntensity: 2.4,
      }),
    [face],
  );
  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
      face.texture.dispose();
    },
    [geometry, material, face],
  );

  useFrame((state) => {
    const look = lookAt(state.clock.elapsedTime, signals.current);
    const key = `${look.open}${look.glance}${colour}`;
    if (key === face.drawn) return;
    face.drawn = key;
    paint(face.context, look, colour);
    face.texture.needsUpdate = true;
  });

  return (
    <>
      <mesh geometry={geometry} material={material} position={CENTRE.toArray()} quaternion={orientation} />
      {/* The eyes' own light, just catching the inside of the hood. */}
      <pointLight position={GLOW.toArray()} color={colour} intensity={0.05} distance={0.3} decay={2} />
    </>
  );
}

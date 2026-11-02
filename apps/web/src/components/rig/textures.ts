"use client";
/**
 * The photographed surfaces (desk, wall), loaded without holding the scene
 * up: everything draws at once in flat colour and gains its texture when it
 * arrives. Each image is fetched once and shared; users get their own copy
 * so each can tile it differently.
 */
import { useEffect, useState } from "react";
import { RepeatWrapping, SRGBColorSpace, TextureLoader, type Texture } from "three";
import { RIG_SURFACES, surfaceUrls } from "./assets";

const loader = new TextureLoader();
const loaded = new Map<string, Promise<Texture>>();

function load(url: string): Promise<Texture> {
  let promise = loaded.get(url);
  if (!promise) {
    promise = loader.loadAsync(url);
    loaded.set(url, promise);
  }
  return promise;
}

/** Every surface's maps, fetched and decoded; resolves even if some fail (they draw in flat colour). */
export function loadSurfaces(): Promise<void> {
  return Promise.allSettled(RIG_SURFACES.flatMap(surfaceUrls).map(load)).then(() => undefined);
}

export interface Surface {
  map?: Texture;
  normalMap?: Texture;
  roughnessMap?: Texture;
}

/** A surface's three maps, tiled `repeat` times, or nothing until they arrive. */
export function useSurface(prefix: "desk" | "wall", repeat: [number, number]): Surface {
  const [surface, setSurface] = useState<Surface>({});
  const [x, y] = repeat;
  useEffect(() => {
    let alive = true;
    let made: Texture[] = [];
    Promise.all(surfaceUrls(prefix).map(load))
      .then((sources) => {
        made = sources.map((source) => {
          const texture = source.clone();
          texture.wrapS = texture.wrapT = RepeatWrapping;
          texture.repeat.set(x, y);
          texture.anisotropy = 4;
          texture.needsUpdate = true;
          return texture;
        });
        made[0]!.colorSpace = SRGBColorSpace;
        if (alive) setSurface({ map: made[0], normalMap: made[1], roughnessMap: made[2] });
      })
      .catch(() => {
        // Flat colour it is.
      });
    return () => {
      alive = false;
      made.forEach((texture) => texture.dispose());
    };
  }, [prefix, x, y]);
  return surface;
}

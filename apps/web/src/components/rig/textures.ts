"use client";
/**
 * The photographed surfaces (desk, wall), loaded without holding the scene
 * up: everything draws at once in flat colour and gains its texture when it
 * arrives. Each image is fetched once and shared; users get their own copy
 * so each can tile it differently.
 */
import { useEffect, useState } from "react";
import { RepeatWrapping, SRGBColorSpace, Texture, TextureLoader } from "three";
import { RIG_SURFACES, surfaceUrls } from "./assets";

const loader = new TextureLoader();
const loaded = new Map<string, Promise<Texture>>();

/**
 * Where the image is decoded off the main thread, as an ImageBitmap: Chromium,
 * and Safari from 17, where it has been checked to give the same texels as an
 * <img>. An <img> handed to WebGL is decoded again, on the main thread, as it
 * is uploaded: a long stall on the scene's first frame.
 */
function bitmaps(): boolean {
  const agent = navigator.userAgent;
  const safari = /^((?!chrome|android).)*safari/i.test(agent) ? Number(agent.match(/Version\/(\d+)/)?.[1] ?? 0) : 0;
  return typeof createImageBitmap !== "undefined" && (/Chrome\//.test(agent) || safari >= 17);
}

/**
 * Fetched once (the page preloads it as a fetch), then decoded. The bitmap is
 * decoded the way WebGL would have read the <img> (flipped, no premultiplying,
 * no colour conversion), so the texture is the same texel for texel.
 */
function decode(url: string): Promise<Texture> {
  return fetch(url, { credentials: "same-origin" })
    .then((response) => {
      if (!response.ok) throw new Error(`${url}: ${response.status}`);
      return response.blob();
    })
    .then((blob) => {
      if (!bitmaps()) {
        const src = URL.createObjectURL(blob);
        return loader.loadAsync(src).finally(() => URL.revokeObjectURL(src));
      }
      return createImageBitmap(blob, { imageOrientation: "flipY", premultiplyAlpha: "none", colorSpaceConversion: "none" }).then((bitmap) => {
        const texture = new Texture(bitmap);
        // Already flipped; WebGL ignores the flag for bitmaps anyway.
        texture.flipY = false;
        texture.needsUpdate = true;
        return texture;
      });
    });
}

function load(url: string): Promise<Texture> {
  let promise = loaded.get(url);
  if (!promise) {
    promise = decode(url);
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

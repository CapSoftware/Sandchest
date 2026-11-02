"use client";
import { useEffect, useState } from "react";
import type { Texture } from "three";
import type { HackerProfile } from "@/lib/hacker";
import { badgeTexture, lidStickers, loadFonts, noteTextures, pageFonts } from "./art";

/** A texture drawn from the profile, redrawn when what it shows changes, and freed when replaced. */
function useDrawn<T extends Texture | Texture[]>(draw: () => Promise<T> | T, key: string): T | null {
  const [value, setValue] = useState<T | null>(null);
  useEffect(() => {
    let alive = true;
    let made: T | null = null;
    const fonts = pageFonts();
    loadFonts(fonts)
      .then(() => draw())
      .then((result) => {
        made = result;
        if (alive) setValue(result);
        else dispose(result);
      });
    return () => {
      alive = false;
      if (made) dispose(made);
    };
    // `key` stands for everything `draw` reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return value;
}

function dispose(value: Texture | Texture[]) {
  for (const texture of Array.isArray(value) ? value : [value]) texture.dispose();
}

export function useStickerTexture(profile: HackerProfile, org: string): Texture | null {
  return useDrawn(() => lidStickers(profile, org, pageFonts()), `${profile.handle}|${profile.stickers.join()}|${org}`);
}

export function useBadgeTexture(profile: HackerProfile, org: string): Texture | null {
  return useDrawn(() => badgeTexture(profile, org, pageFonts()), `${profile.handle}|${profile.phosphor}|${org}`);
}

export function useNoteTextures(): Texture[] | null {
  return useDrawn(() => noteTextures(pageFonts()), "notes");
}

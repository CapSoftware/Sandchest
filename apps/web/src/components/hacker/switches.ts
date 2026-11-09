/**
 * The sound of the hacker's keyboard: real keystrokes, recorded on real
 * keyboards and released into the public domain (CC0) on Freesound, cut by
 * scripts/keys/cut-keys.py into one small file per keyboard
 * (public/keys/<style>.flac: ten ordinary takes, then three deeper ones for
 * wide keys, each with its own release). A key going down plays a take,
 * never the same one twice running, a touch higher or lower and louder or
 * softer each time, from where the key is on the keyboard, left to right.
 */
import { KEYS } from "@/components/rig/keyboard";

export const SWITCHES = [
  { id: "laptop", label: "Laptop" },
  { id: "tactile", label: "Tactile" },
  { id: "thock", label: "Thock" },
  { id: "clicky", label: "Clicky" },
  { id: "typewriter", label: "Typewriter" },
] as const;

export type SwitchId = (typeof SWITCHES)[number]["id"];

/** Each file's takes: all the same length, a hundredth of a second apart; the ordinary ones, then the wide keys'. */
const TAKES: Record<SwitchId, { length: number; keys: number; wide: number }> = {
  laptop: { length: 0.11, keys: 10, wide: 3 },
  tactile: { length: 0.12, keys: 10, wide: 3 },
  thock: { length: 0.12, keys: 10, wide: 3 },
  clicky: { length: 0.12, keys: 10, wide: 3 },
  typewriter: { length: 0.2, keys: 10, wide: 3 },
};
const GAP = 0.01;
/** The files' sample rate: takes start on whole samples, as the cutter wrote them. */
const RATE = 44100;
/** Bump when a file changes: browsers keep them for a year (next.config.ts). */
const VERSION = "1";
/** How loud the keyboard plays, under the radio. */
const VOLUME = 0.9;
/** Keys this much wider than a letter play the deeper takes: the space bar, shifts, enter. */
const WIDE_KEY = 0.03;

/**
 * One keyboard's sound. Made by `keyboardSound()` on a press (browsers only
 * start audio after one); each style's file is fetched the first time it's
 * chosen.
 */
export class KeyboardSound {
  private readonly out: GainNode;
  private readonly buffers = new Map<SwitchId, Promise<AudioBuffer | null>>();
  private loaded: { style: SwitchId; buffer: AudioBuffer } | null = null;
  private style: SwitchId;
  private last = -1;

  constructor(
    private readonly context: AudioContext,
    style: SwitchId,
  ) {
    this.style = style;
    // Overlapping presses never clip.
    const limit = context.createDynamicsCompressor();
    limit.threshold.value = -8;
    limit.knee.value = 4;
    limit.ratio.value = 10;
    limit.attack.value = 0.001;
    limit.release.value = 0.06;
    this.out = context.createGain();
    this.out.gain.value = VOLUME;
    this.out.connect(limit).connect(context.destination);
    void this.load(style);
  }

  /** How loud, 0 to 1 of full. */
  set level(level: number) {
    this.out.gain.setTargetAtTime(VOLUME * Math.max(0, Math.min(1, level)), this.context.currentTime, 0.02);
  }

  set switch(style: SwitchId) {
    this.style = style;
    void this.load(style);
  }

  /** Fetches and decodes a style's file, once. */
  load(style: SwitchId): Promise<AudioBuffer | null> {
    let pending = this.buffers.get(style);
    if (!pending) {
      pending = fetch(`/keys/${style}.flac?v=${VERSION}`)
        .then((response) => (response.ok ? response.arrayBuffer() : Promise.reject(new Error(String(response.status)))))
        .then((data) => this.context.decodeAudioData(data))
        .catch(() => {
          // Try again next time it's chosen.
          this.buffers.delete(style);
          return null;
        });
      this.buffers.set(style, pending);
    }
    void pending.then((buffer) => {
      if (buffer && this.style === style) this.loaded = { style, buffer };
    });
    return pending;
  }

  /** Key `key` (an index into KEYS) going down, now. Its release is in the take. */
  play(key: number): void {
    const { context } = this;
    const loaded = this.loaded;
    if (context.state !== "running" || !loaded || loaded.style !== this.style) return;
    const takes = TAKES[loaded.style];
    const at = KEYS[key];
    const first = at && at.w > WIDE_KEY ? takes.keys : 0;
    const count = first ? takes.wide : takes.keys;
    // A take at random, not the last one played.
    let take = first + Math.floor(Math.random() * count);
    if (take === this.last && count > 1) take = first + ((take - first + 1) % count);
    this.last = take;
    const source = context.createBufferSource();
    source.buffer = loaded.buffer;
    // A touch higher or lower each time.
    source.playbackRate.value = 0.96 + Math.random() * 0.08;
    const gain = context.createGain();
    gain.gain.value = 0.8 + Math.random() * 0.35;
    // Left keys to the left, right keys to the right, gently.
    const pan = context.createStereoPanner();
    pan.pan.value = at ? Math.max(-1, Math.min(1, at.x / 0.15)) * 0.3 : 0;
    source.connect(gain).connect(pan).connect(this.out);
    source.onended = () => pan.disconnect();
    const step = (Math.floor(RATE * takes.length) + Math.floor(RATE * GAP)) / RATE;
    source.start(context.currentTime, take * step, takes.length);
  }

  /** Wakes the sound after the browser has put it to sleep (a press is needed in some). Settles once it's awake: never, if the browser still wants a press. */
  resume(): Promise<void> {
    return this.context.resume();
  }

  /** Whether it's making sound now, rather than asleep or waiting for a press. */
  get running(): boolean {
    return this.context.state === "running";
  }

  /** Puts it to sleep while it's off: no work for the audio thread. */
  suspend(): void {
    void this.context.suspend();
  }

  /** Stops everything for good. */
  close(): void {
    void this.context.close();
  }
}

/** A keyboard's sound for this browser, or null where the browser can't make it. */
export function keyboardSound(style: SwitchId): KeyboardSound | null {
  const Context = typeof window === "undefined" ? undefined : (window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
  if (!Context) return null;
  try {
    return new KeyboardSound(new Context({ latencyHint: "interactive" }), style);
  } catch {
    return null;
  }
}

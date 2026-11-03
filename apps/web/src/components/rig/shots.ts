/** Where the camera stands and looks, for each moment. The laptop sits at the origin; the hacker at z = 0.5. */
export interface Shot {
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
}

export const SHOTS = {
  /** Across the desk from the front left: the hacker side on, and the room behind. */
  wide: { position: [-1.1, 0.66, 1.2], target: [0.02, 0.26, -0.12], fov: 42 },
  /** Over the left shoulder, onto the screen. */
  shoulder: { position: [-0.72, 0.72, 1.32], target: [0.06, 0.1, -0.12], fov: 27 },
  /** Face to face with the hood, over the lid. */
  hood: { position: [0.3, 0.42, -0.95], target: [0, 0.38, 0.4], fov: 32 },
  /** From behind the laptop: the stickers, and the hood facing you. */
  rig: { position: [0.56, 0.3, -0.8], target: [0.02, 0.18, 0.1], fov: 38 },
  /** Down on the desk: the badge and the notes. */
  desk: { position: [-0.16, 0.66, 0.44], target: [-0.2, 0, -0.04], fov: 36 },
  /** Close on the screen, over the right shoulder and past the hood: never through the hacker (who sits between the desk's edge and the chair). */
  screen: { position: [0.36, 0.38, 0.24], target: [0.0, 0.12, -0.11], fov: 30 },
  /** The onboarding's resting shot: side on from behind, the hood against the screen's glow. */
  preview: { position: [1.55, 0.55, 1.15], target: [-0.08, 0.2, 0.12], fov: 30 },
  /** Leaning in from the resting shot, past the hacker's arm, onto the screen: for the moment something is found. */
  lean: { position: [0.7, 0.32, 0.46], target: [0, 0.13, -0.11], fov: 26 },
  /** The same, for watching a scan. */
  watch: { position: [1.55, 0.55, 1.15], target: [-0.08, 0.2, 0.12], fov: 30 },
} satisfies Record<string, Shot>;

export type ShotName = keyof typeof SHOTS;

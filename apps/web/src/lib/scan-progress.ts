/**
 * Where a scan is on its way, from its status and the stages its feed has
 * reached. Pure, so the server draws the same track the client then updates.
 */

export interface TrackStep {
  key: string;
  label: string;
}

const SETUP = { key: "setup", label: "Setup" };
const INDEX = { key: "index", label: "Index" };
const SWEEP = { key: "sweep", label: "Sweep" };
const MAP = { key: "recon", label: "Map" };
const HUNT = { key: "hunt", label: "Hunt" };
const VERIFY = { key: "verify", label: "Verify" };
const REPORT = { key: "report", label: "Report" };
/** A deep scan waiting for its repository's recon, so it starts from that map: the first deep scan, usually. */
const RECON = { key: "wait", label: "Recon" };

/** The feed line a deep scan writes while it waits for its repository's recon. */
export const RECON_WAIT = "queue:recon";

/** Each kind of scan's steps, in the order the engine runs them. */
export const TRACKS: Record<string, readonly TrackStep[]> = {
  deep: [SETUP, INDEX, SWEEP, MAP, HUNT, VERIFY, REPORT],
  pr_review: [SETUP, INDEX, SWEEP, HUNT, VERIFY, REPORT],
  recon: [SETUP, INDEX, MAP, REPORT],
  fix_check: [SETUP, { key: "check", label: "Re-check" }, REPORT],
};

/** A scan's steps: its kind's, led by recon when it waited for one. */
export function trackOf(kind: string, types: readonly string[]): readonly TrackStep[] {
  const track = TRACKS[kind] ?? [];
  return types.includes(RECON_WAIT) ? [RECON, ...track] : track;
}

/** The step a feed line marks the start of, if any. Coverage is more hunting; "done" means reporting. */
export function stepOf(type: string): string | undefined {
  if (type === RECON_WAIT) return RECON.key;
  if (!type.startsWith("stage:")) return type === "progress" ? "check" : undefined;
  const stage = type.slice("stage:".length);
  if (stage === "coverage") return "hunt";
  if (stage === "done") return "report";
  return stage;
}

export type StepState = "done" | "current" | "failed" | "pending";

const ENDED_BADLY = new Set(["failed", "cancelled", "refused"]);

/**
 * Every step's state, along `trackOf`. Waiting scans have no current step, unless they wait for recon;
 * finished ones are all done.
 */
export function trackStates(kind: string, status: string, types: readonly string[]): StepState[] {
  const track = trackOf(kind, types);
  if (status === "completed") return track.map(() => "done");
  let reached = -1;
  for (const type of types) {
    const step = stepOf(type);
    const at = step === undefined ? -1 : track.findIndex((s) => s.key === step);
    if (at > reached) reached = at;
  }
  if (status === "publishing") reached = track.length - 1;
  // Running: on its first step at least, past the recon it waited for.
  const first = track[0] === RECON ? 1 : 0;
  if (status === "running" && reached < first) reached = first;
  const failed = ENDED_BADLY.has(status);
  return track.map((_, i) => (i < reached ? "done" : i === reached ? (failed ? "failed" : "current") : "pending"));
}

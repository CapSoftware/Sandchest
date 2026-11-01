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

/** Each kind of scan's steps, in the order the engine runs them. */
export const TRACKS: Record<string, readonly TrackStep[]> = {
  deep: [SETUP, INDEX, SWEEP, MAP, HUNT, VERIFY, REPORT],
  pr_review: [SETUP, INDEX, SWEEP, HUNT, VERIFY, REPORT],
  recon: [SETUP, INDEX, MAP, REPORT],
  fix_check: [SETUP, { key: "check", label: "Re-check" }, REPORT],
};

/** The step a feed line marks the start of, if any. Coverage is more hunting; "done" means reporting. */
export function stepOf(type: string): string | undefined {
  if (!type.startsWith("stage:")) return type === "progress" ? "check" : undefined;
  const stage = type.slice("stage:".length);
  if (stage === "coverage") return "hunt";
  if (stage === "done") return "report";
  return stage;
}

export type StepState = "done" | "current" | "failed" | "pending";

const ENDED_BADLY = new Set(["failed", "cancelled", "refused"]);

/** Every step's state. Waiting scans have no current step; finished ones are all done. */
export function trackStates(kind: string, status: string, types: readonly string[]): StepState[] {
  const track = TRACKS[kind] ?? [];
  if (status === "completed") return track.map(() => "done");
  let reached = -1;
  for (const type of types) {
    const step = stepOf(type);
    const at = step === undefined ? -1 : track.findIndex((s) => s.key === step);
    if (at > reached) reached = at;
  }
  if (status === "publishing") reached = track.length - 1;
  if (status === "running" && reached < 0) reached = 0;
  const failed = ENDED_BADLY.has(status);
  return track.map((_, i) => (i < reached ? "done" : i === reached ? (failed ? "failed" : "current") : "pending"));
}

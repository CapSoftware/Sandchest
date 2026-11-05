/**
 * CVSS 3.x base scores, for advisories that carry a vector but no severity
 * label (most PyPI, Go and RustSec records). Implements the FIRST
 * specification's base equations, including its rounding.
 */

const WEIGHTS = {
  AV: { N: 0.85, A: 0.62, L: 0.55, P: 0.2 },
  AC: { L: 0.77, H: 0.44 },
  UI: { N: 0.85, R: 0.62 },
  CIA: { H: 0.56, L: 0.22, N: 0 },
} as const;

/** The base score of a `CVSS:3.0/…` or `CVSS:3.1/…` vector, or null when it isn't one. */
export function cvss3Score(vector: string): number | null {
  if (!/^CVSS:3\.[01]\//.test(vector)) return null;
  const metrics = new Map(vector.split("/").slice(1).map((part) => part.split(":") as [string, string]));
  const pick = <T extends Record<string, number>>(table: T, key: string): number | undefined => table[metrics.get(key) as keyof T];
  const scope = metrics.get("S");
  const av = pick(WEIGHTS.AV, "AV");
  const ac = pick(WEIGHTS.AC, "AC");
  const ui = pick(WEIGHTS.UI, "UI");
  const c = pick(WEIGHTS.CIA, "C");
  const i = pick(WEIGHTS.CIA, "I");
  const a = pick(WEIGHTS.CIA, "A");
  const prKey = metrics.get("PR");
  const pr = prKey === "N" ? 0.85 : prKey === "L" ? (scope === "C" ? 0.68 : 0.62) : prKey === "H" ? (scope === "C" ? 0.5 : 0.27) : undefined;
  if (av === undefined || ac === undefined || ui === undefined || pr === undefined || c === undefined || i === undefined || a === undefined || (scope !== "U" && scope !== "C")) return null;

  const iss = 1 - (1 - c) * (1 - i) * (1 - a);
  const impact = scope === "U" ? 6.42 * iss : 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15;
  const exploitability = 8.22 * av * ac * pr * ui;
  if (impact <= 0) return 0;
  return roundUp(Math.min(scope === "U" ? impact + exploitability : 1.08 * (impact + exploitability), 10));
}

/** CVSS 3.1's Roundup: the smallest one-decimal number at or above the input, free of floating-point error. */
function roundUp(value: number): number {
  const scaled = Math.round(value * 100_000);
  return scaled % 10_000 === 0 ? scaled / 100_000 : (Math.floor(scaled / 10_000) + 1) / 10;
}

export type ScoreSeverity = "critical" | "high" | "medium" | "low" | "none";

/** The qualitative rating a CVSS 3 score maps to. */
export function scoreSeverity(score: number): ScoreSeverity {
  if (score >= 9) return "critical";
  if (score >= 7) return "high";
  if (score >= 4) return "medium";
  if (score > 0) return "low";
  return "none";
}

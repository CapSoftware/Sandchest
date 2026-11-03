/**
 * Skeptic: a separate reviewer tries to disprove each candidate. It may drop
 * one by citing the code that blocks the attack, or by ruling that it is no
 * vulnerability at all (nobody can set it off on purpose, or only the
 * attacker is harmed); anything else survives with a confidence.
 */
import type { Message } from "../llm";
import { defineTool } from "../llm";
import { runAgent } from "./agent";
import type { ScanContext } from "./context";
import type { GatedCandidate } from "./gate";
import { skepticSystemPrompt } from "./prompts";
import { VerdictSchema, type Verdict } from "./schema";
import { agentTool, numberLines, type ReadResult } from "./tools";

/** Lines of context read around each cited line. */
const CONTEXT = 8;

const submitVerdict = defineTool({
  name: "submit_verdict",
  description: "Submit your ruling on the candidate. Call exactly once.",
  args: VerdictSchema,
});

export interface Review {
  verdict: Verdict;
  /** False when the skeptic never ruled or its disproof did not hold up; the candidate is kept at low confidence. */
  ruled: boolean;
}

/** Rules on a candidate. `deadline` bounds the review; a candidate not ruled on in time is kept at low confidence. */
export async function review(ctx: ScanContext, gated: GatedCandidate, deadline?: number): Promise<Review> {
  let verdict: Verdict | undefined;
  const verdictTool = agentTool(submitVerdict, async (args: Verdict) => {
    if (args.verdict === "disproved") {
      if (args.disproof.length === 0) return "A disproof must cite the lines that block the attack. Add them, or rule 'confirmed'.";
      const { locations } = await ctx.indexer.call<{ locations: Array<{ file: string; line: number; exists: boolean }> }>(
        "locate",
        { locations: args.disproof.map(({ file, line }) => ({ file, line })) },
        ctx.signal,
      );
      const missing = locations.filter((l) => !l.exists).map((l) => `${l.file}:${l.line}`);
      if (missing.length > 0) return `These cited lines do not exist: ${missing.join(", ")}. Cite real lines, or rule 'confirmed'.`;
    }
    verdict = args;
    return "Verdict recorded.";
  });

  const grounding = `${ctx.authModelText ? `\n\n${ctx.authModelText}` : ""}${ctx.historySkepticText ? `\n\n${ctx.historySkepticText}` : ""}`;
  const messages: Message[] = [
    { role: "system", content: `${skepticSystemPrompt(ctx.tag)}\n\n${ctx.threatModelText}${grounding}` },
    { role: "user", content: `${ctx.wrap(renderCandidate(gated))}\n\nCited code:\n${ctx.wrap(await citedCode(ctx, gated))}` },
  ];
  await runAgent({
    client: ctx.client,
    role: "skeptic",
    messages,
    tools: [...ctx.tools, verdictTool],
    limiter: ctx.limiter,
    meter: ctx.meter,
    maxTurns: ctx.options.skepticTurns,
    done: () => verdict !== undefined,
    deadline,
    priority: "urgent",
    signal: ctx.signal,
  });

  return verdict ? { verdict, ruled: true } : unreviewed(gated, "The reviewer did not reach a verdict");
}

/** Keeps a candidate the skeptic could not rule on, at low confidence so it is hidden by default. */
export function unreviewed(gated: GatedCandidate, reason: string): Review {
  return {
    ruled: false,
    verdict: {
      verdict: "confirmed",
      confidence: "low",
      disproof: [],
      severity: gated.candidate.severity,
      reasoning: `${reason}, so the finding is kept at low confidence.`,
    },
  };
}

export function renderCandidate(gated: GatedCandidate): string {
  const c = gated.candidate;
  const steps = c.path.map((step, i) => `${i + 1}. ${step.file}:${step.line} — ${step.note}`).join("\n");
  return `# Candidate ${gated.id}: ${c.title}
Category: ${c.category}. Claimed severity: ${c.severity}.
Entry point: ${c.entryPoint.description} (${c.entryPoint.file}:${c.entryPoint.line})
Attacker: ${c.preconditions.attacker}. Trigger: ${c.preconditions.trigger}
Preconditions: ${c.preconditions.details}
Impact: ${c.impact}

## Attack path
${steps}

## Proof of concept
${c.proofOfConcept}`;
}

/** The code around every cited line, merged per file. */
export async function citedCode(ctx: ScanContext, gated: GatedCandidate): Promise<string> {
  const ranges = new Map<string, Array<[number, number]>>();
  for (const { file, line } of [gated.entry, ...gated.path]) {
    const list = ranges.get(file) ?? [];
    list.push([Math.max(1, line - CONTEXT), line + CONTEXT]);
    ranges.set(file, list);
  }

  const blocks = await Promise.all(
    [...ranges].map(async ([file, list]) => {
      const merged = mergeRanges(list);
      const parts = await Promise.all(
        merged.map(([startLine, endLine]) => ctx.indexer.call<ReadResult>("read_file", { path: file, startLine, endLine }, ctx.signal)),
      );
      return parts.map((part) => `${file}\n${numberLines(part.content, part.startLine)}`).join("\n…\n");
    }),
  );
  return blocks.join("\n\n");
}

function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of sorted) {
    const last = merged.at(-1);
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

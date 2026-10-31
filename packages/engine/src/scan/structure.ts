/**
 * Structure: a cheap pass (no reasoning, strict JSON schema) that turns a
 * confirmed candidate and the skeptic's notes into the finding developers
 * read. Locations and code excerpts come from the checkout, never the model.
 */
import { generateObject } from "../llm";
import type { ScanContext } from "./context";
import { isFatal } from "./errors";
import { fixPrompt } from "./fix-prompt";
import type { GatedCandidate } from "./gate";
import { STRUCTURE_SYSTEM_PROMPT } from "./prompts";
import { WriteUpSchema, type Finding, type PathStep, type WriteUp } from "./schema";
import { citedCode, renderCandidate, type Review } from "./skeptic";
import { numberLines, type ReadResult } from "./tools";

export async function structure(ctx: ScanContext, gated: GatedCandidate, review: Review): Promise<Finding> {
  const [writeUp, attackPath] = await Promise.all([writeUpFor(ctx, gated, review), excerpts(ctx, gated)]);
  const c = gated.candidate;
  const finding: Omit<Finding, "fixPrompt"> = {
    fingerprint: gated.fingerprint,
    title: writeUp.title,
    severity: writeUp.severity,
    confidence: review.verdict.confidence,
    category: c.category,
    cwe: writeUp.cwe,
    impact: writeUp.impact,
    entryPoint: c.entryPoint,
    attackPath,
    attacker: c.preconditions.attacker,
    preconditions: writeUp.preconditions,
    proofOfConcept: writeUp.proofOfConcept,
    fixGuidance: writeUp.fixGuidance,
    guarantees: writeUp.guarantees,
    mustNotBreak: writeUp.mustNotBreak,
    regressionTest: writeUp.regressionTest,
    leads: c.leads ?? [],
    skeptic: { confidence: review.verdict.confidence, reasoning: review.verdict.reasoning },
  };
  return { ...finding, fixPrompt: fixPrompt(finding) };
}

async function writeUpFor(ctx: ScanContext, gated: GatedCandidate, review: Review): Promise<WriteUp> {
  const v = review.verdict;
  const code = ctx.wrap(await citedCode(ctx, gated));
  try {
    const result = await ctx.limiter.run(() =>
      generateObject(ctx.client, {
        role: "structure",
        name: "finding",
        schema: WriteUpSchema,
        messages: [
          { role: "system", content: STRUCTURE_SYSTEM_PROMPT },
          {
            role: "user",
            content: `${renderCandidate(gated)}\n\n## Reviewer's notes (severity ${v.severity}, confidence ${v.confidence})\n${v.reasoning}\n\nCited code:\n${code}\n\nWrite up this finding. Use the reviewer's severity unless the evidence clearly supports another.`,
          },
        ],
        signal: ctx.signal,
      }),
      "urgent",
    );
    ctx.meter.add("structure", result.usage, result.attempts, result.retries);
    return result.value;
  } catch (error) {
    // Invalid output or a model failure: the hunter's report is a complete write-up on its own.
    if (isFatal(error, ctx.signal)) throw error;
    ctx.emit({ type: "warning", message: `Could not write up ${gated.id}; using the hunter's report as is.` });
    return fallbackWriteUp(gated, review);
  }
}

/** A write-up straight from the candidate, used when the structure pass fails. */
function fallbackWriteUp(gated: GatedCandidate, review: Review): WriteUp {
  const c = gated.candidate;
  const sink = c.path.at(-1)!;
  return {
    title: c.title,
    severity: review.verdict.severity,
    cwe: null,
    impact: c.impact,
    preconditions: `${c.preconditions.attacker.replace("_", " ")}. ${c.preconditions.details}`,
    proofOfConcept: c.proofOfConcept,
    fixGuidance: `Close the attack path at ${sink.file}:${sink.line}: ${sink.note}`,
    guarantees: [`The proof of concept no longer works: ${c.impact}`],
    mustNotBreak: [],
    regressionTest: `Send the proof-of-concept input to ${c.entryPoint.description} and assert it is rejected.`,
  };
}

/** Each cited line with one line of context either side. */
async function excerpts(ctx: ScanContext, gated: GatedCandidate): Promise<PathStep[]> {
  return Promise.all(
    gated.candidate.path.map(async (step) => {
      const read = await ctx.indexer.call<ReadResult>("read_file", { path: step.file, startLine: Math.max(1, step.line - 1), endLine: step.line + 1 }, ctx.signal);
      return { ...step, excerpt: numberLines(read.content, read.startLine) };
    }),
  );
}

/**
 * Auth-model investigation: before reviewing findings, figure out how this
 * application actually enforces authorization — by reading the code, in any
 * language or framework. The model is the framework-agnostic layer (it knows
 * tRPC, Rails, Spring, Express, server actions, decorators without us encoding
 * any of them); the indexer tools and cited file:line are the ground truth that
 * keeps it honest. The result grounds every access-control review, so the
 * skeptic judges a finding against how this app really enforces authz instead
 * of rediscovering it, unreliably, per finding.
 *
 * Runs on the skeptic role, so it inherits the stronger reasoning model when
 * one is configured (LLM_MODEL_SKEPTIC) — the same model that adjudicates.
 */
import { generateObject } from "../llm";
import { runAgent } from "./agent";
import type { ScanContext } from "./context";
import { errorMessage, isFatal, untilDeadline } from "./errors";
import { authInvestigationSystemPrompt } from "./prompts";
import { AuthModelSchema, type AuthModel } from "./schema";

export async function investigateAuthModel(ctx: ScanContext): Promise<AuthModel | undefined> {
  const system = { role: "system" as const, content: authInvestigationSystemPrompt(ctx.tag) };
  try {
    const exploration = await runAgent({
      client: ctx.client,
      role: "skeptic",
      messages: [
        system,
        {
          role: "user",
          content: `${ctx.threatModelText}\n\nInvestigate how this application enforces authorization. Read the request-handling setup, the authentication code, the shared authorization helpers, and a sample of handlers to confirm how enforcement is applied in practice. Then reply with concise notes (under 700 words), each claim grounded in a file:line you have read.`,
        },
      ],
      tools: ctx.tools,
      limiter: ctx.limiter,
      meter: ctx.meter,
      maxTurns: Math.max(ctx.options.reconTurns, 12),
      maxTokens: 4_000,
      deadline: ctx.deadline,
      signal: ctx.signal,
    });

    const result = await ctx.limiter.run(() =>
      generateObject(ctx.client, {
        role: "skeptic",
        name: "auth_model",
        schema: AuthModelSchema,
        maxTokens: 6_000,
        messages: [
          system,
          {
            role: "user",
            content: `${ctx.threatModelText}\n\nInvestigation notes:\n${ctx.wrap(exploration.content || "(none)")}\n\nWrite the authorization model. Every enforcement point and gap must cite a real file:line you read.`,
          },
        ],
        signal: untilDeadline(ctx.signal, ctx.deadline),
      }),
    );
    ctx.meter.add("skeptic", result.usage, result.attempts, result.retries);
    ctx.emit({ type: "progress", message: `Worked out how authorization is enforced (${result.value.enforcementPoints.length} mechanisms, ${result.value.gaps.length} gaps).` });
    return result.value;
  } catch (error) {
    // Grounding is a bonus; without it the skeptic falls back to the threat model, as before.
    if (isFatal(error, ctx.signal)) throw error;
    ctx.emit({ type: "warning", message: `Could not investigate the auth model (${errorMessage(error)}); reviewing without it.` });
    return undefined;
  }
}

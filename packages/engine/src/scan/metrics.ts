import { ROLES, type LlmClient, type Role, type Usage } from "../llm";

export interface RoleUsage extends Usage {
  requests: number;
  /** Transient failures (rate limits, timeouts, dropped streams) that were retried. */
  retries: number;
}

/** USD per million tokens. */
export interface Pricing {
  input: number;
  cachedInput: number;
  output: number;
}

/** Token usage per role for one scan. */
export class UsageMeter {
  readonly byRole: Record<Role, RoleUsage> = Object.fromEntries(
    ROLES.map((role) => [role, { requests: 0, retries: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0 }]),
  ) as Record<Role, RoleUsage>;

  add(role: Role, usage: Usage, requests = 1, retries = 0): void {
    const total = this.byRole[role];
    total.requests += requests;
    total.retries += retries;
    total.inputTokens += usage.inputTokens;
    total.cachedTokens += usage.cachedTokens;
    total.outputTokens += usage.outputTokens;
    total.reasoningTokens += usage.reasoningTokens;
  }

  total(): RoleUsage {
    const sum: RoleUsage = { requests: 0, retries: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0 };
    for (const usage of Object.values(this.byRole)) {
      sum.requests += usage.requests;
      sum.retries += usage.retries;
      sum.inputTokens += usage.inputTokens;
      sum.cachedTokens += usage.cachedTokens;
      sum.outputTokens += usage.outputTokens;
      sum.reasoningTokens += usage.reasoningTokens;
    }
    return sum;
  }

  /** Model cost in USD. Output tokens include reasoning tokens. */
  cost(pricing: Pricing): number {
    const { inputTokens, cachedTokens, outputTokens } = this.total();
    return ((inputTokens - cachedTokens) * pricing.input + cachedTokens * pricing.cachedInput + outputTokens * pricing.output) / 1_000_000;
  }
}

/** One model call, as it is billed: its role, the pipeline stage that made it, its tokens and what it cost. */
export interface UsageEvent extends Usage {
  role: Role | "classifier";
  /** Short machine name of the stage that made the call (`recon`, `hunt`, `review`…). Absent when not known. */
  stage?: string;
  costUsd: number;
  /** `provider`: the endpoint reported the cost. `priced`: computed from `LLM_PRICE_*`, or 0 when they are not set. */
  costSource: "provider" | "priced";
  /** How the call ended. `unpriced`: it finished with no cost reported and none could be computed. */
  status: "ok" | "failed" | "aborted" | "unpriced";
}

/** A call finished with no cost reported while every call must have one. Stops the scan; never retried. */
export class UnpricedCallError extends Error {
  override readonly name = "UnpricedCallError";
  constructor() {
    super("A model call finished with no cost reported");
  }
}

/** Receives every model call a scan makes, once each, as it finishes. */
export type UsageSink = (event: UsageEvent) => void;

/** One call's cost from the price settings, by the same formula as `UsageMeter.cost`. */
export function priceUsage(usage: Usage, pricing: Pricing): number {
  return ((usage.inputTokens - usage.cachedTokens) * pricing.input + usage.cachedTokens * pricing.cachedInput + usage.outputTokens * pricing.output) / 1_000_000;
}

/** One call as a usage event. `providerCostUsd` is what the endpoint reported, if it did. */
export function usageEvent(role: Role, stage: string | undefined, usage: Usage, providerCostUsd: number | undefined, pricing: Pricing | undefined): UsageEvent {
  const provider = providerCostUsd !== undefined;
  return {
    role,
    ...(stage !== undefined && { stage }),
    inputTokens: usage.inputTokens,
    cachedTokens: usage.cachedTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
    costUsd: provider ? providerCostUsd : pricing ? priceUsage(usage, pricing) : 0,
    costSource: provider ? "provider" : "priced",
    status: "ok",
  };
}

/**
 * Clients that report every call they make to `onUsage`, tagged with a stage, including calls that
 * fail. With `requireCost`, a call that finishes with no cost reported and no price set is reported as
 * `unpriced` and then throws `UnpricedCallError`. With neither a sink nor `requireCost`, the client
 * itself for every stage, so a scan without them runs exactly as before. A sink that throws never
 * fails the call.
 */
export function stageClients(client: LlmClient, onUsage: UsageSink | undefined, pricing: Pricing | undefined, options: { requireCost?: boolean } = {}): (stage?: string) => LlmClient {
  const requireCost = options.requireCost === true;
  if (!onUsage && !requireCost) return () => client;
  const report = (event: UsageEvent) => {
    try {
      onUsage?.(event);
    } catch {
      // Recording usage never costs the scan a model call.
    }
  };
  const clients = new Map<string | undefined, LlmClient>();
  return (stage) => {
    let staged = clients.get(stage);
    if (!staged) {
      staged = {
        config: client.config,
        async chat(request, onDelta) {
          let result: Awaited<ReturnType<LlmClient["chat"]>>;
          try {
            result = await client.chat(request, onDelta);
          } catch (error) {
            const none = { inputTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0 };
            report({ role: request.role, ...(stage !== undefined && { stage }), ...none, costUsd: 0, costSource: "provider", status: request.signal?.aborted ? "aborted" : "failed" });
            throw error;
          }
          const event = usageEvent(request.role, stage, result.usage, result.costUsd, pricing);
          if (requireCost && result.costUsd === undefined && !pricing) {
            report({ ...event, status: "unpriced" });
            throw new UnpricedCallError();
          }
          report(event);
          return result;
        },
      };
      clients.set(stage, staged);
    }
    return staged;
  };
}

/** Reads optional `LLM_PRICE_*` variables (USD per million tokens). */
export function loadPricing(env: Record<string, string | undefined> = process.env): Pricing | undefined {
  const input = Number(env.LLM_PRICE_INPUT);
  const output = Number(env.LLM_PRICE_OUTPUT);
  if (!(input >= 0 && output >= 0) || !env.LLM_PRICE_INPUT || !env.LLM_PRICE_OUTPUT) return undefined;
  const cached = Number(env.LLM_PRICE_CACHED_INPUT);
  return { input, output, cachedInput: env.LLM_PRICE_CACHED_INPUT && cached >= 0 ? cached : input };
}

/**
 * Caps how many model requests run at once across every agent in a scan.
 * Urgent work (verifying a reported candidate) jumps the queue ahead of
 * routine work (hunting), so findings do not wait behind exploration.
 */
export class Limiter {
  private active = 0;
  private readonly urgent: Array<() => void> = [];
  private readonly routine: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async run<T>(task: () => Promise<T>, priority: "urgent" | "routine" = "routine"): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => (priority === "urgent" ? this.urgent : this.routine).push(resolve));
    } else {
      this.active++;
    }
    try {
      return await task();
    } finally {
      // Hand the slot straight to the next waiter, or free it.
      const next = this.urgent.shift() ?? this.routine.shift();
      if (next) next();
      else this.active--;
    }
  }
}

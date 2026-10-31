import { ROLES, type Role, type Usage } from "../llm";

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

import { Context, type Effect } from 'effect'

/** Aggregated usage for a single UTC day. */
export interface UsagePeriod {
  readonly orgId: string
  readonly periodStart: Date
  readonly sandboxMinutes: number
  readonly execCount: number
  readonly storageBytes: number
}

/** Summed usage across a date range. */
export interface UsageSummary {
  readonly sandboxMinutes: number
  readonly execCount: number
  readonly storageBytes: number
}

export interface UsageApi {
  /** Increment sandbox-minutes for the current UTC day. */
  readonly recordSandboxMinutes: (orgId: string, minutes: number) => Effect.Effect<void, never, never>

  /** Increment exec count for the current UTC day. */
  readonly recordExec: (orgId: string, count?: number | undefined) => Effect.Effect<void, never, never>

  /** Increment storage bytes for the current UTC day (can be negative for deletions). */
  readonly recordStorageBytes: (orgId: string, bytes: number) => Effect.Effect<void, never, never>

  /** Get usage for the current UTC day. */
  readonly getCurrentPeriodUsage: (orgId: string) => Effect.Effect<UsageSummary, never, never>

  /** Get summed usage across a date range [from, to). */
  readonly getUsage: (orgId: string, from: Date, to: Date) => Effect.Effect<UsageSummary, never, never>

  /** Get all daily usage rows for an org in a date range [from, to). */
  readonly getUsageByPeriod: (orgId: string, from: Date, to: Date) => Effect.Effect<UsagePeriod[], never, never>
}

export class UsageService extends Context.Tag('UsageService')<UsageService, UsageApi>() {}

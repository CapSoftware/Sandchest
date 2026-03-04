import { Effect } from 'effect'
import { bytesToId, SANDBOX_PREFIX } from '@sandchest/contract'
import { SandboxRepo } from '../services/sandbox-repo.js'
import { BillingService } from '../services/billing.js'
import { computeCostForProfile, type BillingTier } from '../services/compute-cost.js'
import type { SandboxRow } from '../services/sandbox-repo.js'
import type { WorkerConfig } from './runner.js'

/**
 * Meter a single sandbox: calculate minutes since last metered (or startedAt),
 * compute the dollar cost, and report to Autumn via billing.trackCompute().
 *
 * Re-reads lastMeteredAt from the repo to avoid double-billing from stale snapshots.
 * Looks up the org's billing tier to apply the correct rates.
 * Skips billing if the sandbox never started (startedAt is null).
 */
export function meterSandbox(
  sandbox: SandboxRow,
  now: Date,
  tierOverride?: BillingTier | undefined,
) {
  return Effect.gen(function* () {
    // Skip sandboxes that never started — no compute to bill
    if (!sandbox.startedAt) return

    const billing = yield* BillingService
    const repo = yield* SandboxRepo

    // Re-read lastMeteredAt fresh from DB to prevent double-billing
    // when multiple workers race on the same sandbox
    const freshLastMetered = yield* repo.getLastMeteredAt(sandbox.id)
    const since = freshLastMetered ?? sandbox.startedAt
    const elapsedMs = now.getTime() - since.getTime()
    if (elapsedMs <= 0) return

    // Determine billing tier from the org's plan (cached in Autumn)
    const tier = tierOverride ?? (yield* billing.getBillingTier(sandbox.orgId))

    const minutes = elapsedMs / 60_000
    const cost = computeCostForProfile(minutes, tier, sandbox.profileName)
    if (cost <= 0) return

    const sandboxId = bytesToId(SANDBOX_PREFIX, sandbox.id)

    // Update lastMeteredAt FIRST to narrow the double-billing window.
    // If trackCompute fails after this, we lose at most one tick of revenue
    // (preferable to double-billing on crash).
    yield* repo.touchLastMetered(sandbox.id)
    yield* billing.trackCompute(sandbox.orgId, cost, sandboxId).pipe(
      Effect.tapError((err) =>
        Effect.logWarning(`Failed to track compute for ${sandboxId}: ${err}`),
      ),
      Effect.catchAll(() => Effect.void),
    )
  })
}

/**
 * Credit metering worker: every 60 seconds, find all running sandboxes
 * and bill the compute delta since last metering.
 */
export const creditMeteringWorker: WorkerConfig<SandboxRepo | BillingService> = {
  name: 'credit-metering',
  intervalMs: 60_000,
  handler: Effect.gen(function* () {
    const repo = yield* SandboxRepo
    const running = yield* repo.findRunningForMetering()
    const now = new Date()

    for (const sandbox of running) {
      yield* meterSandbox(sandbox, now).pipe(
        Effect.catchAll(() => Effect.void),
      )
    }

    return running.length
  }),
}

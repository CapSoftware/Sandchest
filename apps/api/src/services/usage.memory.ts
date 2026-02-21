import { Effect, Layer } from 'effect'
import { UsageService, type UsageApi, type UsagePeriod, type UsageSummary } from './usage.js'

const EMPTY_SUMMARY: UsageSummary = { sandboxMinutes: 0, execCount: 0, storageBytes: 0 }

/** Returns the start of the UTC day for a given date. */
function utcDayStart(date: Date): Date {
  const d = new Date(date)
  d.setUTCHours(0, 0, 0, 0)
  return d
}

function periodKey(orgId: string, periodStart: Date): string {
  return `${orgId}:${periodStart.toISOString()}`
}

export function createInMemoryUsageApi(): UsageApi & {
  /** Get the raw store for test assertions. */
  readonly _store: Map<string, UsagePeriod>
} {
  const store = new Map<string, UsagePeriod>()

  function getOrCreate(orgId: string, periodStart: Date): UsagePeriod {
    const key = periodKey(orgId, periodStart)
    const existing = store.get(key)
    if (existing) return existing
    const period: UsagePeriod = {
      orgId,
      periodStart,
      sandboxMinutes: 0,
      execCount: 0,
      storageBytes: 0,
    }
    store.set(key, period)
    return period
  }

  function upsert(orgId: string, periodStart: Date, update: Partial<UsageSummary>): void {
    const current = getOrCreate(orgId, periodStart)
    const key = periodKey(orgId, periodStart)
    store.set(key, {
      ...current,
      sandboxMinutes: current.sandboxMinutes + (update.sandboxMinutes ?? 0),
      execCount: current.execCount + (update.execCount ?? 0),
      storageBytes: current.storageBytes + (update.storageBytes ?? 0),
    })
  }

  return {
    _store: store,

    recordSandboxMinutes: (orgId, minutes) =>
      Effect.sync(() => {
        upsert(orgId, utcDayStart(new Date()), { sandboxMinutes: minutes })
      }),

    recordExec: (orgId, count) =>
      Effect.sync(() => {
        upsert(orgId, utcDayStart(new Date()), { execCount: count ?? 1 })
      }),

    recordStorageBytes: (orgId, bytes) =>
      Effect.sync(() => {
        upsert(orgId, utcDayStart(new Date()), { storageBytes: bytes })
      }),

    getCurrentPeriodUsage: (orgId) =>
      Effect.sync(() => {
        const key = periodKey(orgId, utcDayStart(new Date()))
        const period = store.get(key)
        if (!period) return EMPTY_SUMMARY
        return {
          sandboxMinutes: period.sandboxMinutes,
          execCount: period.execCount,
          storageBytes: period.storageBytes,
        }
      }),

    getUsage: (orgId, from, to) =>
      Effect.sync(() => {
        let sandboxMinutes = 0
        let execCount = 0
        let storageBytes = 0
        for (const period of store.values()) {
          if (
            period.orgId === orgId &&
            period.periodStart.getTime() >= from.getTime() &&
            period.periodStart.getTime() < to.getTime()
          ) {
            sandboxMinutes += period.sandboxMinutes
            execCount += period.execCount
            storageBytes += period.storageBytes
          }
        }
        return { sandboxMinutes, execCount, storageBytes }
      }),

    getUsageByPeriod: (orgId, from, to) =>
      Effect.sync(() =>
        Array.from(store.values())
          .filter(
            (p) =>
              p.orgId === orgId &&
              p.periodStart.getTime() >= from.getTime() &&
              p.periodStart.getTime() < to.getTime(),
          )
          .sort((a, b) => a.periodStart.getTime() - b.periodStart.getTime()),
      ),
  }
}

export const UsageMemory = Layer.sync(UsageService, () => createInMemoryUsageApi())

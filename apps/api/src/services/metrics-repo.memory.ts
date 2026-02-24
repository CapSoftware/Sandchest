import { Effect, Layer } from 'effect'
import { MetricsRepo, type MetricsRow, type MetricsInput, type MetricsRepoApi } from './metrics-repo.js'

function nodeKey(id: Uint8Array): string {
  return Array.from(id).map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function createInMemoryMetricsRepo(): MetricsRepoApi {
  const store: MetricsRow[] = []
  let counter = 0

  function fakeId(): Uint8Array {
    counter++
    const buf = new Uint8Array(16)
    const view = new DataView(buf.buffer)
    view.setFloat64(0, Date.now())
    view.setFloat64(8, counter)
    return buf
  }

  return {
    insert: (input: MetricsInput) =>
      Effect.sync(() => {
        store.push({
          id: fakeId(),
          nodeId: input.nodeId,
          cpuPercent: input.cpuPercent,
          memoryUsedBytes: input.memoryUsedBytes,
          memoryTotalBytes: input.memoryTotalBytes,
          diskUsedBytes: input.diskUsedBytes,
          diskTotalBytes: input.diskTotalBytes,
          networkRxBytes: input.networkRxBytes,
          networkTxBytes: input.networkTxBytes,
          loadAvg1: input.loadAvg1,
          loadAvg5: input.loadAvg5,
          loadAvg15: input.loadAvg15,
          createdAt: new Date(),
        })
      }),

    getRecent: (nodeId, limit) =>
      Effect.sync(() => {
        const key = nodeKey(nodeId)
        return store
          .filter((m) => nodeKey(m.nodeId) === key)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, limit)
      }),

    deleteOlderThan: (cutoff) =>
      Effect.sync(() => {
        const before = store.length
        const cutoffMs = cutoff.getTime()
        let i = store.length
        while (i--) {
          if (store[i]!.createdAt.getTime() < cutoffMs) {
            store.splice(i, 1)
          }
        }
        return before - store.length
      }),
  }
}

export const MetricsRepoMemory = Layer.sync(MetricsRepo, createInMemoryMetricsRepo)

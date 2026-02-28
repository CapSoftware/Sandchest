'use client'

import { useState } from 'react'
import ServerCard, { ServerCardSkeleton } from '@/components/ServerCard'
import AddServerDialog from '@/components/AddServerDialog'
import { useServers } from '@/hooks/use-servers'
import { useServersMetrics } from '@/hooks/use-servers-metrics'

export default function ServersPage() {
  const { data: servers, isLoading } = useServers()
  const hasProvisioned = servers?.some((s) => s.provision_status === 'completed') ?? false
  const { data: metricsMap } = useServersMetrics(hasProvisioned)
  const [showAdd, setShowAdd] = useState(false)

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Servers</h1>
        <button className="btn btn-primary" onClick={() => setShowAdd(true)}>
          Add Server
        </button>
      </div>

      <div className="card-grid">
        {isLoading ? (
          <>
            <ServerCardSkeleton />
            <ServerCardSkeleton />
            <ServerCardSkeleton />
          </>
        ) : (
          <>
            {servers?.map((server) => (
              <ServerCard
                key={server.id}
                server={server}
                metricsResult={metricsMap?.[server.id]}
              />
            ))}
            <div className="add-server-card" onClick={() => setShowAdd(true)}>
              + Add Server
            </div>
          </>
        )}
      </div>

      {showAdd && <AddServerDialog onClose={() => setShowAdd(false)} />}
    </>
  )
}

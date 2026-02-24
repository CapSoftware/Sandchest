'use client'

import { useState } from 'react'
import ServerCard from '@/components/ServerCard'
import AddServerDialog from '@/components/AddServerDialog'
import { useServers } from '@/hooks/use-servers'

export default function ServersPage() {
  const { data: servers, isLoading } = useServers()
  const [showAdd, setShowAdd] = useState(false)

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Servers</h1>
        <button className="btn btn-primary" onClick={() => setShowAdd(true)}>
          Add Server
        </button>
      </div>

      {isLoading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '3rem' }}>
          <span className="spinner" />
        </div>
      ) : (
        <div className="card-grid">
          {servers?.map((server) => (
            <ServerCard key={server.id} server={server} />
          ))}
          <div className="add-server-card" onClick={() => setShowAdd(true)}>
            + Add Server
          </div>
        </div>
      )}

      {showAdd && <AddServerDialog onClose={() => setShowAdd(false)} />}
    </>
  )
}

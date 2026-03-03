'use client'

import { useState } from 'react'

export interface TrackedSandbox {
  id: string
  status: string
  replayUrl: string
  forkedFrom?: string | undefined
}

interface SandboxInventoryProps {
  sandboxes: TrackedSandbox[]
  activeSandboxId: string | null
  onSelect: (id: string) => void
  onCreateSandbox: (opts: { image: string; profile: string; ttlSeconds: number }) => void
  onStopSandbox: (id: string) => void
  onDestroySandbox: (id: string) => void
  onForkSandbox: (id: string) => void
  creating: boolean
  actionPending: boolean
}

export default function SandboxInventory({
  sandboxes,
  activeSandboxId,
  onSelect,
  onCreateSandbox,
  onStopSandbox,
  onDestroySandbox,
  onForkSandbox,
  creating,
  actionPending,
}: SandboxInventoryProps) {
  const [showCreate, setShowCreate] = useState(false)
  const [image, setImage] = useState('')
  const [profile, setProfile] = useState('micro')
  const [ttl, setTtl] = useState('3600')

  function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    onCreateSandbox({
      image: image || 'default',
      profile,
      ttlSeconds: parseInt(ttl, 10) || 3600,
    })
    setShowCreate(false)
  }

  const active = sandboxes.find((s) => s.id === activeSandboxId)

  return (
    <div className="card sim-sidebar">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
        <div className="card-section-title">Sandboxes</div>
        <button
          className="btn btn-primary btn-sm"
          onClick={() => setShowCreate(!showCreate)}
          disabled={creating}
        >
          {creating ? <><span className="spinner" style={{ width: '0.75rem', height: '0.75rem' }} /></> : '+'}
        </button>
      </div>

      {showCreate && (
        <form onSubmit={handleCreate} style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem', marginBottom: '0.5rem', padding: '0.5rem', background: 'var(--color-background)', borderRadius: '6px' }}>
          <input
            className="form-input"
            value={image}
            onChange={(e) => setImage(e.target.value)}
            placeholder="Image (default)"
            style={{ fontSize: '0.75rem', padding: '0.25rem 0.5rem' }}
          />
          <select
            className="form-input"
            value={profile}
            onChange={(e) => setProfile(e.target.value)}
            style={{ fontSize: '0.75rem', padding: '0.25rem 0.5rem' }}
          >
            <option value="micro">micro</option>
            <option value="small">small</option>
            <option value="medium">medium</option>
            <option value="large">large</option>
          </select>
          <input
            className="form-input"
            type="number"
            value={ttl}
            onChange={(e) => setTtl(e.target.value)}
            placeholder="TTL (seconds)"
            style={{ fontSize: '0.75rem', padding: '0.25rem 0.5rem' }}
          />
          <button type="submit" className="btn btn-primary btn-sm" disabled={creating}>
            {creating ? 'Creating...' : 'Create'}
          </button>
        </form>
      )}

      {sandboxes.length === 0 && !showCreate && (
        <div style={{ fontSize: '0.75rem', color: 'var(--color-text-weak)', padding: '0.5rem 0' }}>
          No sandboxes yet
        </div>
      )}

      {sandboxes.map((sb) => (
        <div
          key={sb.id}
          className="sim-sidebar-item"
          data-active={sb.id === activeSandboxId}
          onClick={() => onSelect(sb.id)}
        >
          <span className="sim-status-dot" data-status={sb.status} />
          <span className="sim-sidebar-item-id">{sb.id}</span>
          {sb.forkedFrom && (
            <span style={{ fontSize: '0.625rem', color: 'var(--color-text-weak)' }}>fork</span>
          )}
        </div>
      ))}

      {active && active.status === 'running' && (
        <div style={{ display: 'flex', gap: '0.375rem', marginTop: '0.5rem' }}>
          <button
            className="btn btn-sm"
            style={{ flex: 1, fontSize: '0.6875rem' }}
            onClick={() => onForkSandbox(active.id)}
            disabled={actionPending}
          >
            Fork
          </button>
          <button
            className="btn btn-sm"
            style={{ flex: 1, fontSize: '0.6875rem' }}
            onClick={() => onStopSandbox(active.id)}
            disabled={actionPending}
          >
            Stop
          </button>
          <button
            className="btn btn-danger btn-sm"
            style={{ flex: 1, fontSize: '0.6875rem' }}
            onClick={() => onDestroySandbox(active.id)}
            disabled={actionPending}
          >
            Destroy
          </button>
        </div>
      )}

      {active && active.status !== 'running' && active.status !== 'deleted' && (
        <div style={{ marginTop: '0.5rem' }}>
          <button
            className="btn btn-danger btn-sm"
            style={{ width: '100%', fontSize: '0.6875rem' }}
            onClick={() => onDestroySandbox(active.id)}
            disabled={actionPending}
          >
            Destroy
          </button>
        </div>
      )}
    </div>
  )
}

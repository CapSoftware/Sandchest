'use client'

import { useState } from 'react'

interface ConnectionPanelProps {
  apiKey: string
  baseUrl: string
  connected: boolean
  onConnect: (apiKey: string, baseUrl: string) => void
  onDisconnect: () => void
}

export default function ConnectionPanel({
  apiKey: initialApiKey,
  baseUrl: initialBaseUrl,
  connected,
  onConnect,
  onDisconnect,
}: ConnectionPanelProps) {
  const [apiKey, setApiKey] = useState(initialApiKey)
  const [baseUrl, setBaseUrl] = useState(initialBaseUrl)

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (connected) {
      onDisconnect()
    } else {
      if (!apiKey.trim() || !baseUrl.trim()) return
      onConnect(apiKey.trim(), baseUrl.trim())
    }
  }

  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
        <div className="card-section-title">Connection</div>
        <div className="sim-connection-status">
          <span className="sim-connection-dot" data-connected={connected} />
          <span style={{ color: connected ? 'var(--color-success)' : 'var(--color-text-weak)' }}>
            {connected ? 'Connected' : 'Disconnected'}
          </span>
        </div>
      </div>

      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        <div className="form-group">
          <label className="form-label">API Key</label>
          <input
            className="form-input"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk_..."
            disabled={connected}
          />
        </div>
        <div className="form-group">
          <label className="form-label">Base URL</label>
          <input
            className="form-input"
            type="url"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.sandchest.com"
            disabled={connected}
          />
        </div>
        <button type="submit" className={`btn btn-sm ${connected ? 'btn-danger' : 'btn-primary'}`}>
          {connected ? 'Disconnect' : 'Connect'}
        </button>
      </form>
    </div>
  )
}

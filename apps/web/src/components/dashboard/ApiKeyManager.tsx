import { useState, useEffect } from 'react'
import { authClient } from '../../lib/auth-client'
import { formatShortDate } from '../../lib/format'

interface ApiKey {
  id: string
  name: string | null
  start: string | null
  createdAt: Date
}

export default function ApiKeyManager() {
  const [keys, setKeys] = useState<ApiKey[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)
  const [newKeyName, setNewKeyName] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [newKeyValue, setNewKeyValue] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [revoking, setRevoking] = useState<Set<string>>(new Set())

  useEffect(() => {
    loadKeys()
  }, [])

  async function loadKeys() {
    setError('')
    try {
      const { data, error: authError } = await authClient.apiKey.list()
      if (authError) {
        setError(authError.message ?? 'Failed to load API keys')
        return
      }
      setKeys(data ?? [])
    } catch {
      setError('Failed to load API keys')
    } finally {
      setLoading(false)
    }
  }

  async function handleCreate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError('')
    setCreating(true)

    try {
      const { data, error: authError } = await authClient.apiKey.create({
        name: newKeyName.trim() || undefined,
      })

      if (authError) {
        setError(authError.message ?? 'Failed to create API key')
        setCreating(false)
        return
      }

      if (data?.key) {
        setNewKeyValue(data.key)
      }

      setNewKeyName('')
      await loadKeys()
    } catch {
      setError('Failed to create API key')
    } finally {
      setCreating(false)
    }
  }

  async function handleRevoke(keyId: string) {
    setRevoking((prev) => new Set(prev).add(keyId))
    try {
      const { error: authError } = await authClient.apiKey.delete({ keyId })
      if (authError) {
        setError(authError.message ?? 'Failed to revoke API key')
        return
      }
      setKeys((prev) => prev.filter((k) => k.id !== keyId))
    } catch {
      setError('Failed to revoke API key')
    } finally {
      setRevoking((prev) => {
        const next = new Set(prev)
        next.delete(keyId)
        return next
      })
    }
  }

  async function handleCopy() {
    if (!newKeyValue) return
    await navigator.clipboard.writeText(newKeyValue)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div>
      <div className="dash-page-header">
        <h1 className="dash-page-title">API Keys</h1>
        <button
          className="dash-primary-btn"
          onClick={() => {
            setShowCreate(!showCreate)
            setNewKeyValue(null)
          }}
        >
          {showCreate ? 'Cancel' : 'Create key'}
        </button>
      </div>

      {error && <p className="dash-error">{error}</p>}

      {newKeyValue && (
        <div className="dash-key-reveal">
          <p className="dash-key-reveal-label">
            Your new API key (copy it now — it won't be shown again):
          </p>
          <div className="dash-key-reveal-row">
            <code className="dash-key-reveal-value">{newKeyValue}</code>
            <button className="dash-action-btn" onClick={handleCopy}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <button
            className="dash-link-btn"
            onClick={() => {
              setNewKeyValue(null)
              setShowCreate(false)
            }}
          >
            Done
          </button>
        </div>
      )}

      {showCreate && !newKeyValue && (
        <form onSubmit={handleCreate} className="dash-create-form">
          <label htmlFor="key-name" className="dash-label">
            Name (optional)
          </label>
          <input
            id="key-name"
            type="text"
            placeholder="e.g. production, staging"
            value={newKeyName}
            onChange={(e) => setNewKeyName(e.target.value)}
            className="dash-input"
            disabled={creating}
            autoFocus
          />
          <button type="submit" className="dash-primary-btn" disabled={creating}>
            {creating ? 'Creating...' : 'Create'}
          </button>
        </form>
      )}

      {loading ? (
        <div className="dash-empty">Loading API keys...</div>
      ) : keys.length === 0 ? (
        <div className="dash-empty">
          No API keys yet. Create one to authenticate SDK and CLI requests.
        </div>
      ) : (
        <div className="dash-table-wrap">
          <table className="dash-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Key</th>
                <th>Created</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => (
                <tr key={key.id}>
                  <td className="dash-text-strong">
                    {key.name || <span className="dash-text-weak">unnamed</span>}
                  </td>
                  <td>
                    <code className="dash-key-prefix">{key.start ?? '???'}...</code>
                  </td>
                  <td className="dash-text-weak">{formatShortDate(key.createdAt)}</td>
                  <td>
                    <button
                      className="dash-action-btn danger"
                      onClick={() => handleRevoke(key.id)}
                      disabled={revoking.has(key.id)}
                    >
                      {revoking.has(key.id) ? 'Revoking...' : 'Revoke'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

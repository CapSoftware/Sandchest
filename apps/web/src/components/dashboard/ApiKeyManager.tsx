'use client'

import { useState } from 'react'
import { useApiKeys, useCreateApiKey, useRevokeApiKey } from '@/hooks/use-api-keys'
import { formatShortDate } from '@/lib/format'
import CopyButton from '@/components/ui/CopyButton'
import EmptyState from '@/components/ui/EmptyState'
import ErrorMessage from '@/components/ui/ErrorMessage'

export default function ApiKeyManager() {
  const { data: keys, isLoading, error } = useApiKeys()
  const createKey = useCreateApiKey()
  const revokeKey = useRevokeApiKey()

  const [newKeyName, setNewKeyName] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [newKeyValue, setNewKeyValue] = useState<string | null>(null)

  function handleCreate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    createKey.mutate(newKeyName.trim() || undefined, {
      onSuccess: (data) => {
        if (data?.key) {
          setNewKeyValue(data.key)
        }
        setNewKeyName('')
      },
    })
  }

  const mutationError = createKey.error ?? revokeKey.error

  return (
    <div>
      <div className="dash-page-header">
        <h1 className="dash-page-title">API Keys</h1>
        <button
          className="dash-primary-btn"
          onClick={() => {
            setShowCreate(!showCreate)
            setNewKeyValue(null)
            createKey.reset()
          }}
        >
          {showCreate ? 'Cancel' : 'Create key'}
        </button>
      </div>

      {error && (
        <ErrorMessage
          message={error instanceof Error ? error.message : 'Failed to load API keys'}
        />
      )}
      {mutationError && (
        <ErrorMessage
          message={
            mutationError instanceof Error
              ? mutationError.message
              : 'Operation failed'
          }
        />
      )}

      {newKeyValue && (
        <div className="dash-key-reveal">
          <p className="dash-key-reveal-label">
            Your new API key (copy it now — it won't be shown again):
          </p>
          <div className="dash-key-reveal-row">
            <code className="dash-key-reveal-value">{newKeyValue}</code>
            <CopyButton text={newKeyValue} />
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
            disabled={createKey.isPending}
            autoFocus
          />
          <button
            type="submit"
            className="dash-primary-btn"
            disabled={createKey.isPending}
          >
            {createKey.isPending ? 'Creating...' : 'Create'}
          </button>
        </form>
      )}

      {isLoading ? (
        <EmptyState message="Loading API keys..." />
      ) : !keys || keys.length === 0 ? (
        <EmptyState message="No API keys yet. Create one to authenticate SDK and CLI requests." />
      ) : (
        <div className="dash-table-wrap">
          <table className="dash-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Key</th>
                <th>Created</th>
                <th scope="col"><span className="sr-only">Actions</span></th>
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
                      onClick={() => revokeKey.mutate(key.id)}
                      disabled={
                        revokeKey.isPending && revokeKey.variables === key.id
                      }
                    >
                      {revokeKey.isPending && revokeKey.variables === key.id
                        ? 'Revoking...'
                        : 'Revoke'}
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

'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { useCreateSandbox } from '@/hooks/use-sandboxes'
import { ApiError } from '@/lib/api'
import { usePaywall } from '@/components/dashboard/PaywallDialog'
import CopyButton from '@/components/ui/CopyButton'
import ErrorMessage from '@/components/ui/ErrorMessage'
import type { ProfileName, CreateSandboxRequest } from '@sandchest/contract'

const PROFILES: Array<{ value: ProfileName; label: string }> = [
  { value: 'small', label: 'Small' },
  { value: 'medium', label: 'Medium' },
  { value: 'large', label: 'Large' },
]

interface EnvEntry {
  key: string
  value: string
}

export default function CreateSandboxDialog({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const createSandbox = useCreateSandbox()
  const { openPaywall } = usePaywall()
  const overlayRef = useRef<HTMLDivElement>(null)

  const [image, setImage] = useState('')
  const [profile, setProfile] = useState<ProfileName>('small')
  const [envEntries, setEnvEntries] = useState<EnvEntry[]>([])
  const [ttl, setTtl] = useState('')
  const [createdId, setCreatedId] = useState<string | null>(null)
  const [createdReplayUrl, setCreatedReplayUrl] = useState<string | null>(null)

  const dismiss = useCallback(() => {
    onClose()
    createSandbox.reset()
    setImage('')
    setProfile('small')
    setEnvEntries([])
    setTtl('')
    setCreatedId(null)
    setCreatedReplayUrl(null)
  }, [onClose, createSandbox])

  useEffect(() => {
    if (!open) return
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') dismiss()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, dismiss])

  useEffect(() => {
    if (!open) return
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = ''
    }
  }, [open])

  if (!open) return null

  function handleOverlayClick(e: React.MouseEvent) {
    if (e.target === overlayRef.current) dismiss()
  }

  function handleAddEnv() {
    setEnvEntries((prev) => [...prev, { key: '', value: '' }])
  }

  function handleRemoveEnv(index: number) {
    setEnvEntries((prev) => prev.filter((_, i) => i !== index))
  }

  function handleEnvChange(index: number, field: 'key' | 'value', val: string) {
    setEnvEntries((prev) =>
      prev.map((entry, i) => (i === index ? { ...entry, [field]: val } : entry)),
    )
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()

    const env: Record<string, string> = {}
    for (const entry of envEntries) {
      const k = entry.key.trim()
      if (k) env[k] = entry.value
    }

    const body: CreateSandboxRequest = {
      profile,
      ...(image.trim() ? { image: image.trim() } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
      ...(ttl.trim() ? { ttl_seconds: Number(ttl) } : {}),
    }

    createSandbox.mutate(body, {
      onSuccess: (data) => {
        setCreatedId(data.sandbox_id)
        setCreatedReplayUrl(data.replay_url)
      },
      onError: (err) => {
        if (err instanceof ApiError && err.status === 403) {
          openPaywall('sandbox_create', 'Sandboxes')
          dismiss()
        }
      },
    })
  }

  const isBillingError =
    createSandbox.error instanceof ApiError && createSandbox.error.status === 403

  return (
    <div
      className="csb-overlay"
      ref={overlayRef}
      onClick={handleOverlayClick}
      role="dialog"
      aria-modal="true"
      aria-label="Create sandbox"
    >
      <div className="csb-dialog">
        <div className="csb-header">
          <h2 className="csb-title">
            {createdId ? 'Sandbox created' : 'Create sandbox'}
          </h2>
          <button className="paywall-close" onClick={dismiss} aria-label="Close">
            <svg
              width="14"
              height="14"
              viewBox="0 0 14 14"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            >
              <path d="M3 3l8 8M11 3l-8 8" />
            </svg>
          </button>
        </div>

        {createSandbox.error && !isBillingError && (
          <ErrorMessage
            message={
              createSandbox.error instanceof Error
                ? createSandbox.error.message
                : 'Failed to create sandbox'
            }
          />
        )}

        {createdId ? (
          <div className="csb-success">
            <p className="csb-success-label">
              Your sandbox is being provisioned.
            </p>
            <div className="csb-success-row">
              <code className="csb-success-id">{createdId}</code>
              <CopyButton text={createdId} />
            </div>
            {createdReplayUrl && (
              <a
                href={createdReplayUrl}
                target="_blank"
                rel="noopener"
                className="csb-replay-link"
              >
                Open replay
              </a>
            )}
            <button className="dash-primary-btn csb-done-btn" onClick={dismiss}>
              Done
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            <div className="dash-field">
              <label htmlFor="csb-profile" className="dash-label">
                Profile
              </label>
              <select
                id="csb-profile"
                value={profile}
                onChange={(e) => setProfile(e.target.value as ProfileName)}
                className="dash-select csb-full-width"
                disabled={createSandbox.isPending}
              >
                {PROFILES.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="dash-field">
              <label htmlFor="csb-image" className="dash-label">
                Image (optional)
              </label>
              <input
                id="csb-image"
                type="text"
                placeholder="default"
                value={image}
                onChange={(e) => setImage(e.target.value)}
                className="dash-input csb-full-width"
                disabled={createSandbox.isPending}
              />
            </div>

            <div className="dash-field">
              <label htmlFor="csb-ttl" className="dash-label">
                TTL in seconds (optional)
              </label>
              <input
                id="csb-ttl"
                type="number"
                placeholder="300"
                min="1"
                value={ttl}
                onChange={(e) => setTtl(e.target.value)}
                className="dash-input csb-full-width"
                disabled={createSandbox.isPending}
              />
            </div>

            <div className="dash-field">
              <div className="csb-env-header">
                <span className="dash-label">Environment variables</span>
                <button
                  type="button"
                  className="csb-add-env-btn"
                  onClick={handleAddEnv}
                  disabled={createSandbox.isPending}
                >
                  + Add
                </button>
              </div>
              {envEntries.map((entry, i) => (
                <div key={i} className="csb-env-row">
                  <input
                    type="text"
                    placeholder="KEY"
                    aria-label={`Environment variable ${i + 1} key`}
                    value={entry.key}
                    onChange={(e) => handleEnvChange(i, 'key', e.target.value)}
                    className="dash-input csb-env-key"
                    disabled={createSandbox.isPending}
                  />
                  <input
                    type="text"
                    placeholder="value"
                    aria-label={`Environment variable ${i + 1} value`}
                    value={entry.value}
                    onChange={(e) => handleEnvChange(i, 'value', e.target.value)}
                    className="dash-input csb-env-value"
                    disabled={createSandbox.isPending}
                  />
                  <button
                    type="button"
                    className="csb-remove-env-btn"
                    onClick={() => handleRemoveEnv(i)}
                    disabled={createSandbox.isPending}
                    aria-label="Remove variable"
                  >
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 14 14"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                    >
                      <path d="M3 3l8 8M11 3l-8 8" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>

            <div className="csb-actions">
              <button
                type="button"
                className="paywall-dismiss-btn"
                onClick={dismiss}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="dash-primary-btn"
                disabled={createSandbox.isPending}
              >
                {createSandbox.isPending ? 'Creating...' : 'Create'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}

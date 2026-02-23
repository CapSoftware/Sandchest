'use client'

import { useReducer, useRef, useEffect, useCallback } from 'react'
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
  id: string
  key: string
  value: string
}

let envEntryCounter = 0

type DialogState = {
  image: string
  profile: ProfileName
  envEntries: EnvEntry[]
  ttl: string
  createdId: string | null
  createdReplayUrl: string | null
}

type DialogAction =
  | { type: 'SET_IMAGE'; value: string }
  | { type: 'SET_PROFILE'; value: ProfileName }
  | { type: 'SET_TTL'; value: string }
  | { type: 'ADD_ENV' }
  | { type: 'REMOVE_ENV'; index: number }
  | { type: 'UPDATE_ENV'; index: number; field: 'key' | 'value'; value: string }
  | { type: 'SET_CREATED'; id: string; replayUrl: string }
  | { type: 'RESET' }

const dialogInitial: DialogState = {
  image: '',
  profile: 'small',
  envEntries: [],
  ttl: '',
  createdId: null,
  createdReplayUrl: null,
}

function dialogReducer(state: DialogState, action: DialogAction): DialogState {
  switch (action.type) {
    case 'SET_IMAGE':
      return { ...state, image: action.value }
    case 'SET_PROFILE':
      return { ...state, profile: action.value }
    case 'SET_TTL':
      return { ...state, ttl: action.value }
    case 'ADD_ENV':
      return { ...state, envEntries: [...state.envEntries, { id: `env-${++envEntryCounter}`, key: '', value: '' }] }
    case 'REMOVE_ENV':
      return { ...state, envEntries: state.envEntries.filter((_, i) => i !== action.index) }
    case 'UPDATE_ENV':
      return {
        ...state,
        envEntries: state.envEntries.map((entry, i) =>
          i === action.index ? { ...entry, [action.field]: action.value } : entry,
        ),
      }
    case 'SET_CREATED':
      return { ...state, createdId: action.id, createdReplayUrl: action.replayUrl }
    case 'RESET':
      return dialogInitial
  }
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

  const [state, dispatch] = useReducer(dialogReducer, dialogInitial)

  const dismiss = useCallback(() => {
    onClose()
    createSandbox.reset()
    dispatch({ type: 'RESET' })
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

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()

    const env: Record<string, string> = {}
    for (const entry of state.envEntries) {
      const k = entry.key.trim()
      if (k) env[k] = entry.value
    }

    const body: CreateSandboxRequest = {
      profile: state.profile,
      ...(state.image.trim() ? { image: state.image.trim() } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
      ...(state.ttl.trim() ? { ttl_seconds: Number(state.ttl) } : {}),
    }

    createSandbox.mutate(body, {
      onSuccess: (data) => {
        dispatch({ type: 'SET_CREATED', id: data.sandbox_id, replayUrl: data.replay_url })
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
      onKeyDown={(e) => { if (e.key === 'Escape') dismiss() }}
      role="dialog"
      aria-modal="true"
      aria-label="Create sandbox"
    >
      <div className="csb-dialog">
        <div className="csb-header">
          <h2 className="csb-title">
            {state.createdId ? 'Sandbox created' : 'Create sandbox'}
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

        {state.createdId ? (
          <div className="csb-success">
            <p className="csb-success-label">
              Your sandbox is being provisioned.
            </p>
            <div className="csb-success-row">
              <code className="csb-success-id">{state.createdId}</code>
              <CopyButton text={state.createdId} />
            </div>
            {state.createdReplayUrl && (
              <a
                href={state.createdReplayUrl}
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
                value={state.profile}
                onChange={(e) => dispatch({ type: 'SET_PROFILE', value: e.target.value as ProfileName })}
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
                value={state.image}
                onChange={(e) => dispatch({ type: 'SET_IMAGE', value: e.target.value })}
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
                value={state.ttl}
                onChange={(e) => dispatch({ type: 'SET_TTL', value: e.target.value })}
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
                  onClick={() => dispatch({ type: 'ADD_ENV' })}
                  disabled={createSandbox.isPending}
                >
                  + Add
                </button>
              </div>
              {state.envEntries.map((entry, i) => (
                <div key={entry.id} className="csb-env-row">
                  <input
                    type="text"
                    placeholder="KEY"
                    aria-label={`Environment variable ${i + 1} key`}
                    value={entry.key}
                    onChange={(e) => dispatch({ type: 'UPDATE_ENV', index: i, field: 'key', value: e.target.value })}
                    className="dash-input csb-env-key"
                    disabled={createSandbox.isPending}
                  />
                  <input
                    type="text"
                    placeholder="value"
                    aria-label={`Environment variable ${i + 1} value`}
                    value={entry.value}
                    onChange={(e) => dispatch({ type: 'UPDATE_ENV', index: i, field: 'value', value: e.target.value })}
                    className="dash-input csb-env-value"
                    disabled={createSandbox.isPending}
                  />
                  <button
                    type="button"
                    className="csb-remove-env-btn"
                    onClick={() => dispatch({ type: 'REMOVE_ENV', index: i })}
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

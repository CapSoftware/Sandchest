'use client'

import { useReducer, useRef, useEffect } from 'react'
import {
  useOrgSettings,
  useUpdateOrgName,
  useInviteMember,
  useRemoveMember,
} from '@/hooks/use-org-settings'
import EmptyState from '@/components/ui/EmptyState'
import ErrorMessage from '@/components/ui/ErrorMessage'
import { SettingsSkeleton } from './skeletons'

type SettingsState = {
  orgName: string
  nameInitialized: boolean
  inviteEmail: string
  inviteRole: 'member' | 'admin'
  updateSuccess: boolean
}

type SettingsAction =
  | { type: 'SET_ORG_NAME'; value: string }
  | { type: 'INIT_NAME'; value: string }
  | { type: 'SET_INVITE_EMAIL'; value: string }
  | { type: 'SET_INVITE_ROLE'; value: 'member' | 'admin' }
  | { type: 'SET_UPDATE_SUCCESS'; value: boolean }
  | { type: 'CLEAR_INVITE_EMAIL' }

const settingsInitial: SettingsState = {
  orgName: '',
  nameInitialized: false,
  inviteEmail: '',
  inviteRole: 'member',
  updateSuccess: false,
}

function settingsReducer(state: SettingsState, action: SettingsAction): SettingsState {
  switch (action.type) {
    case 'SET_ORG_NAME':
      return { ...state, orgName: action.value }
    case 'INIT_NAME':
      return { ...state, orgName: action.value, nameInitialized: true }
    case 'SET_INVITE_EMAIL':
      return { ...state, inviteEmail: action.value }
    case 'SET_INVITE_ROLE':
      return { ...state, inviteRole: action.value }
    case 'SET_UPDATE_SUCCESS':
      return { ...state, updateSuccess: action.value }
    case 'CLEAR_INVITE_EMAIL':
      return { ...state, inviteEmail: '' }
  }
}

export default function OrgSettings() {
  const { data, isLoading, error } = useOrgSettings()
  const updateName = useUpdateOrgName()
  const invite = useInviteMember()
  const removeMember = useRemoveMember()

  const [state, dispatch] = useReducer(settingsReducer, settingsInitial)
  const successTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (successTimerRef.current) clearTimeout(successTimerRef.current)
    }
  }, [])

  // Sync org name to local state once data loads
  if (data && !state.nameInitialized) {
    dispatch({ type: 'INIT_NAME', value: data.org.name })
  }

  const org = data?.org
  const members = data?.members ?? []
  const mutationError = updateName.error ?? invite.error ?? removeMember.error

  function handleUpdateName(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!org) return
    dispatch({ type: 'SET_UPDATE_SUCCESS', value: false })
    updateName.mutate(state.orgName.trim(), {
      onSuccess: () => {
        dispatch({ type: 'SET_UPDATE_SUCCESS', value: true })
        if (successTimerRef.current) clearTimeout(successTimerRef.current)
        successTimerRef.current = setTimeout(() => dispatch({ type: 'SET_UPDATE_SUCCESS', value: false }), 3000)
      },
    })
  }

  function handleInvite(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    invite.mutate(
      { email: state.inviteEmail.trim(), role: state.inviteRole },
      { onSuccess: () => dispatch({ type: 'CLEAR_INVITE_EMAIL' }) },
    )
  }

  if (isLoading) {
    return <SettingsSkeleton />
  }

  if (!org) {
    return (
      <div>
        <div className="dash-page-header">
          <h1 className="dash-page-title">Settings</h1>
        </div>
        {error && (
          <ErrorMessage
            message={
              error instanceof Error ? error.message : 'Failed to load organization'
            }
          />
        )}
        <EmptyState message="No organization found. You may need to create or join one." />
      </div>
    )
  }

  return (
    <div>
      <div className="dash-page-header">
        <h1 className="dash-page-title">Settings</h1>
      </div>

      {error && (
        <ErrorMessage
          message={
            error instanceof Error ? error.message : 'Failed to load organization'
          }
        />
      )}
      {mutationError && (
        <ErrorMessage
          message={
            mutationError instanceof Error ? mutationError.message : 'Operation failed'
          }
        />
      )}

      {/* Org name */}
      <section className="dash-section">
        <h2 className="dash-section-title">Organization</h2>
        <form onSubmit={handleUpdateName} className="dash-inline-form">
          <div className="dash-field">
            <label htmlFor="org-name" className="dash-label">Name</label>
            <input
              id="org-name"
              type="text"
              value={state.orgName}
              onChange={(e) => dispatch({ type: 'SET_ORG_NAME', value: e.target.value })}
              className="dash-input"
              disabled={updateName.isPending}
            />
          </div>
          <div className="dash-field">
            <label htmlFor="org-slug" className="dash-label">Slug</label>
            <p id="org-slug" className="dash-static-value">{org.slug}</p>
          </div>
          <div className="dash-field">
            <label htmlFor="org-id" className="dash-label">ID</label>
            <p id="org-id" className="dash-static-value">
              <code>{org.id}</code>
            </p>
          </div>
          <button
            type="submit"
            className="dash-primary-btn"
            disabled={updateName.isPending || state.orgName.trim() === org.name}
          >
            {updateName.isPending ? 'Saving...' : state.updateSuccess ? 'Saved' : 'Save'}
          </button>
        </form>
      </section>

      {/* Members */}
      <section className="dash-section">
        <h2 className="dash-section-title">Members</h2>

        {members.length > 0 && (
          <div className="dash-table-wrap">
            <table className="dash-table">
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Name</th>
                  <th>Role</th>
                  <th scope="col"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.id}>
                    <td className="dash-text-strong">{m.user.email}</td>
                    <td className="dash-text-weak">{m.user.name || '—'}</td>
                    <td className="dash-text-weak">{m.role}</td>
                    <td>
                      {m.role !== 'owner' && (
                        <button
                          className="dash-action-btn danger"
                          onClick={() => removeMember.mutate(m.id)}
                          disabled={
                            removeMember.isPending &&
                            removeMember.variables === m.id
                          }
                        >
                          {removeMember.isPending &&
                          removeMember.variables === m.id
                            ? 'Removing...'
                            : 'Remove'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <form onSubmit={handleInvite} className="dash-invite-form">
          <input
            type="email"
            placeholder="Email address"
            value={state.inviteEmail}
            onChange={(e) => dispatch({ type: 'SET_INVITE_EMAIL', value: e.target.value })}
            className="dash-input"
            disabled={invite.isPending}
            aria-label="Invite email address"
          />
          <select
            value={state.inviteRole}
            onChange={(e) => dispatch({ type: 'SET_INVITE_ROLE', value: e.target.value as 'member' | 'admin' })}
            className="dash-select"
            disabled={invite.isPending}
          >
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
          <button
            type="submit"
            className="dash-primary-btn"
            disabled={invite.isPending || !state.inviteEmail.trim()}
          >
            {invite.isPending ? 'Inviting...' : 'Invite'}
          </button>
        </form>
      </section>
    </div>
  )
}

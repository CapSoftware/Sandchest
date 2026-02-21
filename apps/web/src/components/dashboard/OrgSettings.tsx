'use client'

import { useState, useRef, useEffect } from 'react'
import {
  useOrgSettings,
  useUpdateOrgName,
  useInviteMember,
  useRemoveMember,
} from '@/hooks/use-org-settings'
import EmptyState from '@/components/ui/EmptyState'
import ErrorMessage from '@/components/ui/ErrorMessage'

export default function OrgSettings() {
  const { data, isLoading, error } = useOrgSettings()
  const updateName = useUpdateOrgName()
  const invite = useInviteMember()
  const removeMember = useRemoveMember()

  const [orgName, setOrgName] = useState('')
  const [nameInitialized, setNameInitialized] = useState(false)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<'member' | 'admin'>('member')
  const [updateSuccess, setUpdateSuccess] = useState(false)
  const successTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (successTimerRef.current) clearTimeout(successTimerRef.current)
    }
  }, [])

  // Sync org name to local state once data loads
  if (data && !nameInitialized) {
    setOrgName(data.org.name)
    setNameInitialized(true)
  }

  const org = data?.org
  const members = data?.members ?? []
  const mutationError = updateName.error ?? invite.error ?? removeMember.error

  function handleUpdateName(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!org) return
    setUpdateSuccess(false)
    updateName.mutate(orgName.trim(), {
      onSuccess: () => {
        setUpdateSuccess(true)
        if (successTimerRef.current) clearTimeout(successTimerRef.current)
        successTimerRef.current = setTimeout(() => setUpdateSuccess(false), 3000)
      },
    })
  }

  function handleInvite(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    invite.mutate(
      { email: inviteEmail.trim(), role: inviteRole },
      { onSuccess: () => setInviteEmail('') },
    )
  }

  if (isLoading) {
    return <EmptyState message="Loading organization settings..." />
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
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
              className="dash-input"
              disabled={updateName.isPending}
            />
          </div>
          <div className="dash-field">
            <label className="dash-label">Slug</label>
            <p className="dash-static-value">{org.slug}</p>
          </div>
          <div className="dash-field">
            <label className="dash-label">ID</label>
            <p className="dash-static-value">
              <code>{org.id}</code>
            </p>
          </div>
          <button
            type="submit"
            className="dash-primary-btn"
            disabled={updateName.isPending || orgName.trim() === org.name}
          >
            {updateName.isPending ? 'Saving...' : updateSuccess ? 'Saved' : 'Save'}
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
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
            className="dash-input"
            disabled={invite.isPending}
            aria-label="Invite email address"
          />
          <select
            value={inviteRole}
            onChange={(e) => setInviteRole(e.target.value as 'member' | 'admin')}
            className="dash-select"
            disabled={invite.isPending}
          >
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
          <button
            type="submit"
            className="dash-primary-btn"
            disabled={invite.isPending || !inviteEmail.trim()}
          >
            {invite.isPending ? 'Inviting...' : 'Invite'}
          </button>
        </form>
      </section>
    </div>
  )
}

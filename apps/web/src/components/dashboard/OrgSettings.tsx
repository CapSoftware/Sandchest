'use client'

import { useState, useEffect } from 'react'
import { authClient } from '@/lib/auth-client'
import EmptyState from '@/components/ui/EmptyState'
import ErrorMessage from '@/components/ui/ErrorMessage'

interface OrgData {
  id: string
  name: string
  slug: string
  createdAt: Date
}

interface OrgMember {
  id: string
  userId: string
  role: string
  user: {
    name: string
    email: string
  }
}

export default function OrgSettings() {
  const [org, setOrg] = useState<OrgData | null>(null)
  const [members, setMembers] = useState<OrgMember[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [orgName, setOrgName] = useState('')
  const [updating, setUpdating] = useState(false)
  const [updateSuccess, setUpdateSuccess] = useState(false)

  // Invite state
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<'member' | 'admin'>('member')
  const [inviting, setInviting] = useState(false)

  useEffect(() => {
    loadOrg()
  }, [])

  async function loadOrg() {
    setError('')
    try {
      const { data: orgData, error: orgError } = await authClient.organization.getFullOrganization()

      if (orgError) {
        setError(orgError.message ?? 'Failed to load organization')
        setLoading(false)
        return
      }

      if (orgData) {
        setOrg(orgData as unknown as OrgData)
        setOrgName((orgData as unknown as OrgData).name)
        setMembers((orgData as unknown as { members: OrgMember[] }).members ?? [])
      }
    } catch {
      setError('Failed to load organization')
    } finally {
      setLoading(false)
    }
  }

  async function handleUpdateName(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!org) return
    setUpdating(true)
    setError('')
    setUpdateSuccess(false)

    try {
      const { error: updateError } = await authClient.organization.update({
        data: { name: orgName.trim() },
      })

      if (updateError) {
        setError(updateError.message ?? 'Failed to update organization')
        setUpdating(false)
        return
      }

      setUpdateSuccess(true)
      setTimeout(() => setUpdateSuccess(false), 3000)
    } catch {
      setError('Failed to update organization')
    } finally {
      setUpdating(false)
    }
  }

  async function handleInvite(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setInviting(true)
    setError('')

    try {
      const { error: inviteError } = await authClient.organization.inviteMember({
        email: inviteEmail.trim(),
        role: inviteRole,
      })

      if (inviteError) {
        setError(inviteError.message ?? 'Failed to send invite')
        setInviting(false)
        return
      }

      setInviteEmail('')
      await loadOrg()
    } catch {
      setError('Failed to send invite')
    } finally {
      setInviting(false)
    }
  }

  async function handleRemoveMember(memberId: string) {
    setError('')
    try {
      const { error: removeError } = await authClient.organization.removeMember({
        memberIdOrEmail: memberId,
      })

      if (removeError) {
        setError(removeError.message ?? 'Failed to remove member')
        return
      }

      setMembers((prev) => prev.filter((m) => m.id !== memberId))
    } catch {
      setError('Failed to remove member')
    }
  }

  if (loading) {
    return <EmptyState message="Loading organization settings..." />
  }

  if (!org) {
    return (
      <div>
        <div className="dash-page-header">
          <h1 className="dash-page-title">Settings</h1>
        </div>
        <EmptyState message="No organization found. You may need to create or join one." />
      </div>
    )
  }

  return (
    <div>
      <div className="dash-page-header">
        <h1 className="dash-page-title">Settings</h1>
      </div>

      {error && <ErrorMessage message={error} />}

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
              disabled={updating}
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
            disabled={updating || orgName.trim() === org.name}
          >
            {updating ? 'Saving...' : updateSuccess ? 'Saved' : 'Save'}
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
                  <th></th>
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
                          onClick={() => handleRemoveMember(m.id)}
                        >
                          Remove
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
            disabled={inviting}
          />
          <select
            value={inviteRole}
            onChange={(e) => setInviteRole(e.target.value as 'member' | 'admin')}
            className="dash-select"
            disabled={inviting}
          >
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
          <button
            type="submit"
            className="dash-primary-btn"
            disabled={inviting || !inviteEmail.trim()}
          >
            {inviting ? 'Inviting...' : 'Invite'}
          </button>
        </form>
      </section>
    </div>
  )
}

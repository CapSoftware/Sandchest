'use client'

import { useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { useAddServer } from '@/hooks/use-add-server'

export default function AddServerDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter()
  const addServer = useAddServer()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [name, setName] = useState('')
  const [ip, setIp] = useState('')
  const [sshPort, setSshPort] = useState(22)
  const [sshUser, setSshUser] = useState('root')
  const [sshKey, setSshKey] = useState('')
  const [sshPassword, setSshPassword] = useState('')
  const [slotsTotal, setSlotsTotal] = useState(4)
  const [authMode, setAuthMode] = useState<'key' | 'password'>('key')

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const text = await file.text()
    setSshKey(text)
  }

  const hasAuth = authMode === 'key' ? sshKey.length > 0 : sshPassword.length > 0

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    try {
      const input = authMode === 'key'
        ? { name, ip, ssh_port: sshPort, ssh_user: sshUser, ssh_key: sshKey, slots_total: slotsTotal }
        : { name, ip, ssh_port: sshPort, ssh_user: sshUser, ssh_password: sshPassword, slots_total: slotsTotal }
      const result = await addServer.mutateAsync(input)
      onClose()
      router.push(`/servers/${result.id}`)
    } catch {
      // Error handled by mutation state
    }
  }

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog-content" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-title">Add Server</div>
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div className="form-group">
            <label className="form-label" htmlFor="server-name">Name</label>
            <input
              id="server-name"
              className="form-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. hetzner-fsn1-01"
              required
            />
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="server-ip">IP Address</label>
            <input
              id="server-ip"
              className="form-input"
              value={ip}
              onChange={(e) => setIp(e.target.value)}
              placeholder="e.g. 88.99.123.45"
              required
            />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
            <div className="form-group">
              <label className="form-label" htmlFor="ssh-port">SSH Port</label>
              <input
                id="ssh-port"
                type="number"
                className="form-input"
                value={sshPort}
                onChange={(e) => setSshPort(Number(e.target.value))}
              />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="ssh-user">SSH User</label>
              <input
                id="ssh-user"
                className="form-input"
                value={sshUser}
                onChange={(e) => setSshUser(e.target.value)}
              />
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">Authentication</label>
            <div style={{
              display: 'inline-flex',
              borderRadius: '6px',
              border: '1px solid var(--color-border)',
              overflow: 'hidden',
              marginBottom: '0.25rem',
            }}>
              <button
                type="button"
                onClick={() => setAuthMode('key')}
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.75rem',
                  fontWeight: 500,
                  padding: '0.3125rem 0.75rem',
                  border: 'none',
                  cursor: 'pointer',
                  backgroundColor: authMode === 'key' ? 'var(--color-accent)' : 'var(--color-surface)',
                  color: authMode === 'key' ? 'var(--color-background)' : 'var(--color-text)',
                  transition: 'background-color 0.15s, color 0.15s',
                }}
              >
                SSH Key
              </button>
              <button
                type="button"
                onClick={() => setAuthMode('password')}
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.75rem',
                  fontWeight: 500,
                  padding: '0.3125rem 0.75rem',
                  border: 'none',
                  borderLeft: '1px solid var(--color-border)',
                  cursor: 'pointer',
                  backgroundColor: authMode === 'password' ? 'var(--color-accent)' : 'var(--color-surface)',
                  color: authMode === 'password' ? 'var(--color-background)' : 'var(--color-text)',
                  transition: 'background-color 0.15s, color 0.15s',
                }}
              >
                Password
              </button>
            </div>

            {authMode === 'key' ? (
              <>
                <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.25rem' }}>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    Upload file
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".pem,.key,*"
                    onChange={handleFileUpload}
                    style={{ display: 'none' }}
                  />
                </div>
                <textarea
                  className="form-input"
                  value={sshKey}
                  onChange={(e) => setSshKey(e.target.value)}
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                  rows={6}
                />
              </>
            ) : (
              <input
                type="password"
                className="form-input"
                value={sshPassword}
                onChange={(e) => setSshPassword(e.target.value)}
                placeholder="Root password from provider"
                autoComplete="off"
              />
            )}
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="slots-total">Slots Total</label>
            <input
              id="slots-total"
              type="number"
              className="form-input"
              value={slotsTotal}
              onChange={(e) => setSlotsTotal(Number(e.target.value))}
              min={1}
              max={256}
            />
          </div>

          {addServer.error && (
            <div style={{ fontSize: '0.8125rem', color: 'var(--color-danger)' }}>
              {addServer.error.message}
            </div>
          )}

          <div className="dialog-actions">
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={addServer.isPending || !name || !ip || !hasAuth}
            >
              {addServer.isPending
                ? authMode === 'password'
                  ? <><span className="spinner" /> Setting up...</>
                  : <span className="spinner" />
                : 'Add Server'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

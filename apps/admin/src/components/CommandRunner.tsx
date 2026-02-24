'use client'

import { useState, useRef, useEffect } from 'react'
import { useCommand } from '@/hooks/use-command'

interface HistoryEntry {
  command: string
  stdout: string
  stderr: string
  exit_code: number
  duration_ms: number
}

export default function CommandRunner({ serverId }: { serverId: string }) {
  const [command, setCommand] = useState('')
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const outputRef = useRef<HTMLDivElement>(null)
  const commandMutation = useCommand(serverId)

  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight
    }
  }, [history])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!command.trim()) return

    const cmd = command
    setCommand('')

    try {
      const result = await commandMutation.mutateAsync(cmd)
      setHistory((prev) => [...prev, { command: cmd, ...result }])
    } catch {
      setHistory((prev) => [
        ...prev,
        { command: cmd, stdout: '', stderr: 'Failed to execute command', exit_code: -1, duration_ms: 0 },
      ])
    }
  }

  return (
    <div className="card">
      <div style={{ fontWeight: 600, fontSize: '0.8125rem', color: 'var(--color-text-strong)', marginBottom: '0.75rem' }}>
        Command Runner
      </div>

      <div ref={outputRef} className="terminal-output" style={{ marginBottom: '0.75rem' }}>
        {history.length === 0 && (
          <span style={{ color: 'var(--color-text-weak)' }}>Run a command on the server...</span>
        )}
        {history.map((entry, i) => (
          <div key={i} style={{ marginBottom: '0.5rem' }}>
            <div style={{ color: 'var(--color-accent)' }}>$ {entry.command}</div>
            {entry.stdout && <div className="terminal-stdout">{entry.stdout}</div>}
            {entry.stderr && <div className="terminal-stderr">{entry.stderr}</div>}
            <div style={{ color: 'var(--color-text-weak)', fontSize: '0.6875rem' }}>
              exit {entry.exit_code} ({entry.duration_ms}ms)
            </div>
          </div>
        ))}
        {commandMutation.isPending && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span className="spinner" /> Running...
          </div>
        )}
      </div>

      <form onSubmit={handleSubmit} style={{ display: 'flex', gap: '0.5rem' }}>
        <input
          className="form-input"
          style={{ flex: 1 }}
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder="e.g. uptime"
          disabled={commandMutation.isPending}
        />
        <button
          type="submit"
          className="btn btn-primary btn-sm"
          disabled={commandMutation.isPending || !command.trim()}
        >
          Run
        </button>
      </form>
    </div>
  )
}

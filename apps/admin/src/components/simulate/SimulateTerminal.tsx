'use client'

import { useState, useRef, useEffect } from 'react'

interface HistoryEntry {
  command: string
  stdout: string
  stderr: string
  exitCode: number
  durationMs: number
}

interface SimulateTerminalProps {
  onExec: (command: string) => Promise<{
    exitCode: number
    stdout: string
    stderr: string
    durationMs: number
  }>
  isPending: boolean
  placeholder?: string | undefined
  emptyMessage?: string | undefined
}

export default function SimulateTerminal({
  onExec,
  isPending,
  placeholder = 'e.g. echo hello',
  emptyMessage = 'Run a command...',
}: SimulateTerminalProps) {
  const [command, setCommand] = useState('')
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [cmdHistory, setCmdHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState(-1)
  const outputRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight
    }
  }, [history])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!command.trim() || isPending) return

    const cmd = command
    setCommand('')
    setCmdHistory((prev) => [cmd, ...prev])
    setHistoryIndex(-1)

    try {
      const result = await onExec(cmd)
      setHistory((prev) => [...prev, {
        command: cmd,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
      }])
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Command failed'
      setHistory((prev) => [...prev, {
        command: cmd,
        stdout: '',
        stderr: message,
        exitCode: -1,
        durationMs: 0,
      }])
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (cmdHistory.length > 0 && historyIndex < cmdHistory.length - 1) {
        const newIndex = historyIndex + 1
        setHistoryIndex(newIndex)
        setCommand(cmdHistory[newIndex]!)
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (historyIndex > 0) {
        const newIndex = historyIndex - 1
        setHistoryIndex(newIndex)
        setCommand(cmdHistory[newIndex]!)
      } else if (historyIndex === 0) {
        setHistoryIndex(-1)
        setCommand('')
      }
    }
  }

  return (
    <div>
      <div ref={outputRef} className="terminal-output" style={{ marginBottom: '0.75rem' }}>
        {history.length === 0 && (
          <span style={{ color: 'var(--color-text-weak)' }}>{emptyMessage}</span>
        )}
        {history.map((entry, i) => (
          <div key={i} style={{ marginBottom: '0.5rem' }}>
            <div style={{ color: 'var(--color-accent)' }}>$ {entry.command}</div>
            {entry.stdout && <div className="terminal-stdout">{entry.stdout}</div>}
            {entry.stderr && <div className="terminal-stderr">{entry.stderr}</div>}
            <div style={{ color: 'var(--color-text-weak)', fontSize: '0.6875rem' }}>
              exit {entry.exitCode} ({entry.durationMs}ms)
            </div>
          </div>
        ))}
        {isPending && (
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
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={isPending}
        />
        <button
          type="submit"
          className="btn btn-primary btn-sm"
          disabled={isPending || !command.trim()}
        >
          Run
        </button>
      </form>
    </div>
  )
}

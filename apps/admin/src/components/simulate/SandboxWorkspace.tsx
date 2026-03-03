'use client'

import { useState } from 'react'
import SimulateTerminal from './SimulateTerminal'
import SessionPanel from './SessionPanel'
import FileBrowser from './FileBrowser'

type Tab = 'terminal' | 'session' | 'files' | 'info'

interface SandboxWorkspaceProps {
  sandboxId: string
  sandboxStatus: string
  replayUrl: string
  onSandboxExec: (command: string) => Promise<{
    exitCode: number
    stdout: string
    stderr: string
    durationMs: number
  }>
  onCreateSession: (shell?: string | undefined) => Promise<{ sessionId: string }>
  onDestroySession: (sessionId: string) => Promise<void>
  onSessionExec: (sessionId: string, command: string) => Promise<{
    exitCode: number
    stdout: string
    stderr: string
    durationMs: number
  }>
  onListFiles: (path: string) => Promise<{ files: Array<{ name: string; type: 'file' | 'dir'; size: number; modified: string }> }>
  onUploadFile: (path: string, file: File) => Promise<void>
  onDeleteFile: (path: string) => Promise<void>
  onDownloadFile: (path: string) => void
  execPending: boolean
  sessionExecPending: boolean
  filePending: boolean
}

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'terminal', label: 'Terminal' },
  { key: 'session', label: 'Session' },
  { key: 'files', label: 'Files' },
  { key: 'info', label: 'Info' },
]

export default function SandboxWorkspace({
  sandboxId,
  sandboxStatus,
  replayUrl,
  onSandboxExec,
  onCreateSession,
  onDestroySession,
  onSessionExec,
  onListFiles,
  onUploadFile,
  onDeleteFile,
  onDownloadFile,
  execPending,
  sessionExecPending,
  filePending,
}: SandboxWorkspaceProps) {
  const [activeTab, setActiveTab] = useState<Tab>('terminal')
  const isRunning = sandboxStatus === 'running'

  return (
    <div className="card" style={{ flex: 1 }}>
      <div className="sim-tabs">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            className="sim-tab"
            data-active={activeTab === tab.key}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {!isRunning && activeTab !== 'info' && (
        <div style={{ fontSize: '0.8125rem', color: 'var(--color-text-weak)', padding: '2rem', textAlign: 'center' }}>
          Sandbox is not running (status: {sandboxStatus})
        </div>
      )}

      {activeTab === 'terminal' && isRunning && (
        <SimulateTerminal
          onExec={onSandboxExec}
          isPending={execPending}
          placeholder="e.g. echo hello"
          emptyMessage="Run a command in the sandbox..."
        />
      )}

      {activeTab === 'session' && isRunning && (
        <SessionPanel
          onCreateSession={onCreateSession}
          onDestroySession={onDestroySession}
          onSessionExec={onSessionExec}
          isPending={sessionExecPending}
        />
      )}

      {activeTab === 'files' && isRunning && (
        <FileBrowser
          onListFiles={onListFiles}
          onUploadFile={onUploadFile}
          onDeleteFile={onDeleteFile}
          onDownloadFile={onDownloadFile}
          isPending={filePending}
        />
      )}

      {activeTab === 'info' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', fontSize: '0.75rem' }}>
          <div>
            <span style={{ color: 'var(--color-text-weak)' }}>Sandbox ID:</span>{' '}
            <span style={{ color: 'var(--color-text-strong)' }}>{sandboxId}</span>
          </div>
          <div>
            <span style={{ color: 'var(--color-text-weak)' }}>Status:</span>{' '}
            <span className={`badge badge-${sandboxStatus}`}>
              <span className="badge-dot" />
              {sandboxStatus}
            </span>
          </div>
          {replayUrl && (
            <div>
              <span style={{ color: 'var(--color-text-weak)' }}>Replay URL:</span>{' '}
              <a
                href={replayUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: 'var(--color-accent)' }}
              >
                {replayUrl}
              </a>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

'use client'

import { useState, useCallback } from 'react'
import ConnectionPanel from '@/components/simulate/ConnectionPanel'
import SandboxInventory from '@/components/simulate/SandboxInventory'
import type { TrackedSandbox } from '@/components/simulate/SandboxInventory'
import SandboxWorkspace from '@/components/simulate/SandboxWorkspace'
import {
  useCreateSandbox,
  useDestroySandbox,
  useStopSandbox,
  useSandboxExec,
  useForkSandbox,
  useCreateSession,
  useDestroySession,
  useSessionExec,
  useListFiles,
  useUploadFile,
  useDeleteFile,
} from '@/hooks/use-simulate'

export default function SimulatePage() {
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('https://api.sandchest.com')
  const [connected, setConnected] = useState(false)
  const [sandboxes, setSandboxes] = useState<TrackedSandbox[]>([])
  const [activeSandboxId, setActiveSandboxId] = useState<string | null>(null)

  const createSandbox = useCreateSandbox()
  const destroySandbox = useDestroySandbox()
  const stopSandbox = useStopSandbox()
  const sandboxExec = useSandboxExec()
  const forkSandbox = useForkSandbox()
  const createSession = useCreateSession()
  const destroySession = useDestroySession()
  const sessionExec = useSessionExec()
  const listFiles = useListFiles()
  const uploadFile = useUploadFile()
  const deleteFile = useDeleteFile()

  const creds = { apiKey, baseUrl }
  const activeSandbox = sandboxes.find((s) => s.id === activeSandboxId) ?? null

  function handleConnect(key: string, url: string) {
    setApiKey(key)
    setBaseUrl(url)
    setConnected(true)
  }

  function handleDisconnect() {
    setConnected(false)
    setSandboxes([])
    setActiveSandboxId(null)
  }

  async function handleCreateSandbox(opts: { image: string; profile: string; ttlSeconds: number }) {
    const result = await createSandbox.mutateAsync({
      ...creds,
      image: opts.image,
      profile: opts.profile,
      ttlSeconds: opts.ttlSeconds,
    })
    const newSandbox: TrackedSandbox = {
      id: result.id,
      status: result.status,
      replayUrl: result.replayUrl,
    }
    setSandboxes((prev) => [...prev, newSandbox])
    setActiveSandboxId(result.id)
  }

  function handleStopSandbox(id: string) {
    stopSandbox.mutate({ ...creds, sandboxId: id }, {
      onSuccess: (data) => {
        setSandboxes((prev) =>
          prev.map((s) => s.id === id ? { ...s, status: data.status } : s)
        )
      },
    })
  }

  function handleDestroySandbox(id: string) {
    destroySandbox.mutate({ ...creds, sandboxId: id }, {
      onSuccess: () => {
        setSandboxes((prev) => prev.filter((s) => s.id !== id))
        if (activeSandboxId === id) {
          setActiveSandboxId(null)
        }
      },
    })
  }

  async function handleForkSandbox(id: string) {
    const result = await forkSandbox.mutateAsync({ ...creds, sandboxId: id })
    const newSandbox: TrackedSandbox = {
      id: result.id,
      status: result.status,
      replayUrl: result.replayUrl,
      forkedFrom: id,
    }
    setSandboxes((prev) => [...prev, newSandbox])
    setActiveSandboxId(result.id)
  }

  const handleSandboxExec = useCallback(async (command: string) => {
    if (!activeSandboxId) throw new Error('No active sandbox')
    return sandboxExec.mutateAsync({ ...creds, sandboxId: activeSandboxId, command })
  }, [activeSandboxId, creds.apiKey, creds.baseUrl])

  const handleCreateSession = useCallback(async (shell?: string | undefined) => {
    if (!activeSandboxId) throw new Error('No active sandbox')
    return createSession.mutateAsync({ ...creds, sandboxId: activeSandboxId, shell })
  }, [activeSandboxId, creds.apiKey, creds.baseUrl])

  const handleDestroySession = useCallback(async (sessionId: string) => {
    if (!activeSandboxId) throw new Error('No active sandbox')
    await destroySession.mutateAsync({ ...creds, sandboxId: activeSandboxId, sessionId })
  }, [activeSandboxId, creds.apiKey, creds.baseUrl])

  const handleSessionExec = useCallback(async (sessionId: string, command: string) => {
    if (!activeSandboxId) throw new Error('No active sandbox')
    return sessionExec.mutateAsync({ ...creds, sandboxId: activeSandboxId, sessionId, command })
  }, [activeSandboxId, creds.apiKey, creds.baseUrl])

  const handleListFiles = useCallback(async (path: string) => {
    if (!activeSandboxId) throw new Error('No active sandbox')
    return listFiles.mutateAsync({ ...creds, sandboxId: activeSandboxId, path })
  }, [activeSandboxId, creds.apiKey, creds.baseUrl])

  const handleUploadFile = useCallback(async (path: string, file: File) => {
    if (!activeSandboxId) throw new Error('No active sandbox')
    await uploadFile.mutateAsync({ ...creds, sandboxId: activeSandboxId, path, file })
  }, [activeSandboxId, creds.apiKey, creds.baseUrl])

  const handleDeleteFile = useCallback(async (path: string) => {
    if (!activeSandboxId) throw new Error('No active sandbox')
    await deleteFile.mutateAsync({ ...creds, sandboxId: activeSandboxId, path })
  }, [activeSandboxId, creds.apiKey, creds.baseUrl])

  const handleDownloadFile = useCallback((path: string) => {
    if (!activeSandboxId) return
    const url = new URL('/api/simulate/files/download', window.location.origin)
    url.searchParams.set('sandboxId', activeSandboxId)
    url.searchParams.set('path', path)

    const a = document.createElement('a')
    a.href = url.toString()
    // Pass credentials via fetch instead of direct link
    fetch(url.toString(), {
      headers: {
        'x-simulate-api-key': apiKey,
        'x-simulate-base-url': baseUrl,
      },
    })
      .then((res) => res.blob())
      .then((blob) => {
        const objUrl = URL.createObjectURL(blob)
        a.href = objUrl
        a.download = path.split('/').pop() ?? 'download'
        a.click()
        URL.revokeObjectURL(objUrl)
      })
      .catch(() => {
        // Silently fail download
      })
  }, [activeSandboxId, apiKey, baseUrl])

  const actionPending = stopSandbox.isPending || destroySandbox.isPending || forkSandbox.isPending

  return (
    <div className="sim-layout">
      <div className="page-header">
        <h1 className="page-title">Simulate</h1>
      </div>

      <ConnectionPanel
        apiKey={apiKey}
        baseUrl={baseUrl}
        connected={connected}
        onConnect={handleConnect}
        onDisconnect={handleDisconnect}
      />

      {connected && (
        <div className="sim-workspace">
          <SandboxInventory
            sandboxes={sandboxes}
            activeSandboxId={activeSandboxId}
            onSelect={setActiveSandboxId}
            onCreateSandbox={handleCreateSandbox}
            onStopSandbox={handleStopSandbox}
            onDestroySandbox={handleDestroySandbox}
            onForkSandbox={handleForkSandbox}
            creating={createSandbox.isPending}
            actionPending={actionPending}
          />

          {activeSandbox ? (
            <SandboxWorkspace
              key={activeSandbox.id}
              sandboxId={activeSandbox.id}
              sandboxStatus={activeSandbox.status}
              replayUrl={activeSandbox.replayUrl}
              onSandboxExec={handleSandboxExec}
              onCreateSession={handleCreateSession}
              onDestroySession={handleDestroySession}
              onSessionExec={handleSessionExec}
              onListFiles={handleListFiles}
              onUploadFile={handleUploadFile}
              onDeleteFile={handleDeleteFile}
              onDownloadFile={handleDownloadFile}
              execPending={sandboxExec.isPending}
              sessionExecPending={sessionExec.isPending}
              filePending={uploadFile.isPending || deleteFile.isPending}
            />
          ) : (
            <div className="card" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <span style={{ color: 'var(--color-text-weak)', fontSize: '0.8125rem' }}>
                {sandboxes.length === 0 ? 'Create a sandbox to get started' : 'Select a sandbox'}
              </span>
            </div>
          )}
        </div>
      )}

      {createSandbox.isError && (
        <div className="card feedback-card feedback-danger">
          Failed to create sandbox: {createSandbox.error.message}
        </div>
      )}
      {forkSandbox.isError && (
        <div className="card feedback-card feedback-danger">
          Failed to fork sandbox: {forkSandbox.error.message}
        </div>
      )}
      {stopSandbox.isError && (
        <div className="card feedback-card feedback-danger">
          Failed to stop sandbox: {stopSandbox.error.message}
        </div>
      )}
      {destroySandbox.isError && (
        <div className="card feedback-card feedback-danger">
          Failed to destroy sandbox: {destroySandbox.error.message}
        </div>
      )}
    </div>
  )
}

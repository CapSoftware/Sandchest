'use client'

import { useMutation } from '@tanstack/react-query'

interface Credentials {
  apiKey: string
  baseUrl: string
}

interface SandboxResult {
  id: string
  status: string
  replayUrl: string
}

interface ExecResult {
  execId: string
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
}

interface SessionResult {
  sessionId: string
  sandboxId: string
}

interface FileEntry {
  name: string
  type: 'file' | 'dir'
  size: number
  modified: string
}

export function useCreateSandbox() {
  return useMutation({
    mutationFn: async (params: Credentials & {
      image?: string | undefined
      profile?: string | undefined
      ttlSeconds?: number | undefined
    }): Promise<SandboxResult> => {
      const res = await fetch('/api/simulate/sandbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      })
      if (!res.ok) {
        const data = (await res.json().catch(() => ({ error: 'Request failed' }))) as { error: string }
        throw new Error(data.error)
      }
      return res.json() as Promise<SandboxResult>
    },
  })
}

export function useDestroySandbox() {
  return useMutation({
    mutationFn: async (params: Credentials & { sandboxId: string }): Promise<void> => {
      const res = await fetch('/api/simulate/sandbox', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      })
      if (!res.ok) {
        const data = (await res.json().catch(() => ({ error: 'Request failed' }))) as { error: string }
        throw new Error(data.error)
      }
    },
  })
}

export function useStopSandbox() {
  return useMutation({
    mutationFn: async (params: Credentials & { sandboxId: string }): Promise<{ status: string }> => {
      const res = await fetch('/api/simulate/sandbox/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      })
      if (!res.ok) {
        const data = (await res.json().catch(() => ({ error: 'Request failed' }))) as { error: string }
        throw new Error(data.error)
      }
      return res.json() as Promise<{ status: string }>
    },
  })
}

export function useSandboxExec() {
  return useMutation({
    mutationFn: async (params: Credentials & {
      sandboxId: string
      command: string
      cwd?: string | undefined
    }): Promise<ExecResult> => {
      const res = await fetch('/api/simulate/sandbox/exec', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      })
      if (!res.ok) {
        const data = (await res.json().catch(() => ({ error: 'Request failed' }))) as { error: string }
        throw new Error(data.error)
      }
      return res.json() as Promise<ExecResult>
    },
  })
}

export function useForkSandbox() {
  return useMutation({
    mutationFn: async (params: Credentials & { sandboxId: string }): Promise<SandboxResult> => {
      const res = await fetch('/api/simulate/sandbox/fork', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      })
      if (!res.ok) {
        const data = (await res.json().catch(() => ({ error: 'Request failed' }))) as { error: string }
        throw new Error(data.error)
      }
      return res.json() as Promise<SandboxResult>
    },
  })
}

export function useCreateSession() {
  return useMutation({
    mutationFn: async (params: Credentials & {
      sandboxId: string
      shell?: string | undefined
    }): Promise<SessionResult> => {
      const res = await fetch('/api/simulate/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      })
      if (!res.ok) {
        const data = (await res.json().catch(() => ({ error: 'Request failed' }))) as { error: string }
        throw new Error(data.error)
      }
      return res.json() as Promise<SessionResult>
    },
  })
}

export function useDestroySession() {
  return useMutation({
    mutationFn: async (params: Credentials & {
      sandboxId: string
      sessionId: string
    }): Promise<void> => {
      const res = await fetch('/api/simulate/session', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      })
      if (!res.ok) {
        const data = (await res.json().catch(() => ({ error: 'Request failed' }))) as { error: string }
        throw new Error(data.error)
      }
    },
  })
}

export function useSessionExec() {
  return useMutation({
    mutationFn: async (params: Credentials & {
      sandboxId: string
      sessionId: string
      command: string
    }): Promise<ExecResult> => {
      const res = await fetch('/api/simulate/session/exec', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      })
      if (!res.ok) {
        const data = (await res.json().catch(() => ({ error: 'Request failed' }))) as { error: string }
        throw new Error(data.error)
      }
      return res.json() as Promise<ExecResult>
    },
  })
}

export function useListFiles() {
  return useMutation({
    mutationFn: async (params: Credentials & {
      sandboxId: string
      path: string
    }): Promise<{ files: FileEntry[] }> => {
      const url = new URL('/api/simulate/files', window.location.origin)
      url.searchParams.set('sandboxId', params.sandboxId)
      url.searchParams.set('path', params.path)

      const res = await fetch(url.toString(), {
        headers: {
          'x-simulate-api-key': params.apiKey,
          'x-simulate-base-url': params.baseUrl,
        },
      })
      if (!res.ok) {
        const data = (await res.json().catch(() => ({ error: 'Request failed' }))) as { error: string }
        throw new Error(data.error)
      }
      return res.json() as Promise<{ files: FileEntry[] }>
    },
  })
}

export function useUploadFile() {
  return useMutation({
    mutationFn: async (params: Credentials & {
      sandboxId: string
      path: string
      file: File
    }): Promise<void> => {
      const formData = new FormData()
      formData.set('apiKey', params.apiKey)
      formData.set('baseUrl', params.baseUrl)
      formData.set('sandboxId', params.sandboxId)
      formData.set('path', params.path)
      formData.set('file', params.file)

      const res = await fetch('/api/simulate/files', {
        method: 'POST',
        body: formData,
      })
      if (!res.ok) {
        const data = (await res.json().catch(() => ({ error: 'Request failed' }))) as { error: string }
        throw new Error(data.error)
      }
    },
  })
}

export function useDeleteFile() {
  return useMutation({
    mutationFn: async (params: Credentials & {
      sandboxId: string
      path: string
    }): Promise<void> => {
      const res = await fetch('/api/simulate/files', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      })
      if (!res.ok) {
        const data = (await res.json().catch(() => ({ error: 'Request failed' }))) as { error: string }
        throw new Error(data.error)
      }
    },
  })
}

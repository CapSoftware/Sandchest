'use client'

import { useState, useRef } from 'react'

interface FileEntry {
  name: string
  type: 'file' | 'dir'
  size: number
  modified: string
}

interface FileBrowserProps {
  onListFiles: (path: string) => Promise<{ files: FileEntry[] }>
  onUploadFile: (path: string, file: File) => Promise<void>
  onDeleteFile: (path: string) => Promise<void>
  onDownloadFile: (path: string) => void
  isPending: boolean
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '-'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export default function FileBrowser({
  onListFiles,
  onUploadFile,
  onDeleteFile,
  onDownloadFile,
  isPending,
}: FileBrowserProps) {
  const [currentPath, setCurrentPath] = useState('/')
  const [files, setFiles] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pathInput, setPathInput] = useState('/')
  const fileInputRef = useRef<HTMLInputElement>(null)

  async function loadDirectory(path: string) {
    setLoading(true)
    setError(null)
    try {
      const result = await onListFiles(path)
      setFiles(result.files)
      setCurrentPath(path)
      setPathInput(path)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to list files')
    } finally {
      setLoading(false)
    }
  }

  function handleNavigate(e: React.FormEvent) {
    e.preventDefault()
    loadDirectory(pathInput.trim() || '/')
  }

  function handleEntryClick(entry: FileEntry) {
    if (entry.type === 'dir') {
      const newPath = currentPath === '/'
        ? `/${entry.name}`
        : `${currentPath}/${entry.name}`
      loadDirectory(newPath)
    }
  }

  function handleGoUp() {
    if (currentPath === '/') return
    const parts = currentPath.split('/')
    parts.pop()
    loadDirectory(parts.join('/') || '/')
  }

  async function handleUpload() {
    const file = fileInputRef.current?.files?.[0]
    if (!file) return

    const uploadPath = currentPath === '/'
      ? `/${file.name}`
      : `${currentPath}/${file.name}`

    try {
      await onUploadFile(uploadPath, file)
      if (fileInputRef.current) fileInputRef.current.value = ''
      loadDirectory(currentPath)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed')
    }
  }

  async function handleDelete(name: string) {
    const fullPath = currentPath === '/'
      ? `/${name}`
      : `${currentPath}/${name}`

    if (!confirm(`Delete ${fullPath}?`)) return

    try {
      await onDeleteFile(fullPath)
      loadDirectory(currentPath)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed')
    }
  }

  function handleDownload(name: string) {
    const fullPath = currentPath === '/'
      ? `/${name}`
      : `${currentPath}/${name}`
    onDownloadFile(fullPath)
  }

  return (
    <div>
      <form onSubmit={handleNavigate} style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem' }}>
        <button
          type="button"
          className="btn btn-sm"
          onClick={handleGoUp}
          disabled={currentPath === '/' || loading}
        >
          ..
        </button>
        <input
          className="form-input"
          style={{ flex: 1 }}
          value={pathInput}
          onChange={(e) => setPathInput(e.target.value)}
          placeholder="/"
        />
        <button type="submit" className="btn btn-sm" disabled={loading}>
          {loading ? <span className="spinner" style={{ width: '0.75rem', height: '0.75rem' }} /> : 'Go'}
        </button>
      </form>

      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem', alignItems: 'center' }}>
        <input
          ref={fileInputRef}
          type="file"
          style={{ fontSize: '0.75rem', color: 'var(--color-text)', flex: 1 }}
        />
        <button
          className="btn btn-sm"
          onClick={handleUpload}
          disabled={isPending}
        >
          Upload
        </button>
      </div>

      {error && (
        <div className="card feedback-card feedback-danger" style={{ marginBottom: '0.75rem' }}>{error}</div>
      )}

      {files.length === 0 && !loading && !error && (
        <div style={{ fontSize: '0.75rem', color: 'var(--color-text-weak)', padding: '1rem 0', textAlign: 'center' }}>
          Click &ldquo;Go&rdquo; to browse files, or navigate to a path
        </div>
      )}

      {files.length > 0 && (
        <table className="sim-file-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Size</th>
              <th style={{ width: '80px' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {files.map((f) => (
              <tr key={f.name}>
                <td>
                  <span
                    className={`sim-file-name ${f.type === 'dir' ? 'sim-file-dir' : ''}`}
                    onClick={() => handleEntryClick(f)}
                  >
                    {f.type === 'dir' ? `${f.name}/` : f.name}
                  </span>
                </td>
                <td style={{ color: 'var(--color-text-weak)' }}>{f.type}</td>
                <td style={{ color: 'var(--color-text-weak)' }}>{formatSize(f.size)}</td>
                <td>
                  <div style={{ display: 'flex', gap: '0.25rem' }}>
                    {f.type === 'file' && (
                      <button
                        className="btn btn-sm"
                        style={{ fontSize: '0.625rem', padding: '0.125rem 0.375rem' }}
                        onClick={() => handleDownload(f.name)}
                      >
                        DL
                      </button>
                    )}
                    <button
                      className="btn btn-danger btn-sm"
                      style={{ fontSize: '0.625rem', padding: '0.125rem 0.375rem' }}
                      onClick={() => handleDelete(f.name)}
                      disabled={isPending}
                    >
                      RM
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

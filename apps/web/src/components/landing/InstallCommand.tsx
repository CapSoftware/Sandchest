'use client'

import { useState, useRef } from 'react'

const commands: Record<string, string> = {
  bun: 'bun add @sandchest/sdk',
  pnpm: 'pnpm add @sandchest/sdk',
  yarn: 'yarn add @sandchest/sdk',
  npm: 'npm install @sandchest/sdk',
}

const pkgManagers = ['bun', 'pnpm', 'yarn', 'npm'] as const

export default function InstallCommand() {
  const [activePkg, setActivePkg] = useState('bun')
  const [copied, setCopied] = useState(false)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function handleCopy() {
    navigator.clipboard.writeText(commands[activePkg])
    setCopied(true)
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    timeoutRef.current = setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="hero-reveal hero-reveal-delay-3">
      <div className="bg-surface" style={{ borderTopLeftRadius: 6, borderTopRightRadius: 6, padding: '0 20px' }}>
        <div className="pkg-tabs flex items-center">
          {pkgManagers.map((pkg) => (
            <button
              key={pkg}
              className={`pkg-tab${activePkg === pkg ? ' active' : ''}`}
              onClick={() => setActivePkg(pkg)}
            >
              {pkg}
            </button>
          ))}
        </div>
      </div>

      <div className="bg-surface flex items-center justify-between" style={{ borderBottomLeftRadius: 6, borderBottomRightRadius: 6, padding: 16 }}>
        <div
          className="install-cmd flex items-center"
          style={{ gap: 16, padding: '8px 16px 8px 8px', borderRadius: 4, cursor: 'pointer' }}
          role="button"
          tabIndex={0}
          onClick={handleCopy}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleCopy() } }}
        >
          <code className="install-text text-text-strong">{commands[activePkg]}</code>
          <button
            className="text-text-weak transition-colors hover:text-text-strong shrink-0"
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
            aria-label="Copy to clipboard"
            onClick={(e) => { e.stopPropagation(); handleCopy() }}
          >
            {copied ? (
              <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="#03B000" strokeWidth="2">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square">
                <rect x="9" y="9" width="13" height="13" rx="1" />
                <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
              </svg>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}

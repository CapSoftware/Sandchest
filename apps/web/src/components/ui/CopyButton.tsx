'use client'

import { useState } from 'react'

interface CopyButtonProps {
  text: string
  label?: string | undefined
  copiedLabel?: string | undefined
  className?: string | undefined
}

export default function CopyButton({
  text,
  label = 'Copy',
  copiedLabel = 'Copied',
  className = 'dash-action-btn',
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <button className={className} onClick={handleCopy}>
      {copied ? copiedLabel : label}
    </button>
  )
}

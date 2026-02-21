import { useMemo } from 'react'
import type { CSSProperties } from 'react'
import { parseAnsi } from './ansi-parser'

interface AnsiTextProps {
  text: string
  className?: string | undefined
}

export default function AnsiText({ text, className }: AnsiTextProps) {
  const segments = useMemo(() => parseAnsi(text), [text])

  return (
    <pre className={className ?? 'replay-terminal'}>
      {segments.map((seg, i) => {
        const style: CSSProperties = {}
        if (seg.fg) style.color = seg.fg
        if (seg.bg) style.backgroundColor = seg.bg
        if (seg.bold) style.fontWeight = 700
        if (seg.dim) style.opacity = 0.6
        if (seg.underline) style.textDecoration = 'underline'

        const hasStyle = seg.fg || seg.bg || seg.bold || seg.dim || seg.underline
        if (!hasStyle) return seg.text

        return (
          <span key={i} style={style}>
            {seg.text}
          </span>
        )
      })}
    </pre>
  )
}

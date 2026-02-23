import { useMemo } from 'react'
import type { CSSProperties } from 'react'
import { parseAnsi } from './ansi-parser'

interface AnsiTextProps {
  text: string
  className?: string | undefined
}

export default function AnsiText({ text, className }: AnsiTextProps) {
  const keyedSegments = useMemo(
    () => parseAnsi(text).map((seg, idx) => ({ ...seg, key: `s${idx}` })),
    [text],
  )

  return (
    <pre className={className ?? 'replay-terminal'}>
      {keyedSegments.map((seg) => {
        const style: CSSProperties = {}
        if (seg.fg) style.color = seg.fg
        if (seg.bg) style.backgroundColor = seg.bg
        if (seg.bold) style.fontWeight = 700
        if (seg.dim) style.opacity = 0.6
        if (seg.underline) style.textDecoration = 'underline'

        const hasStyle = seg.fg || seg.bg || seg.bold || seg.dim || seg.underline
        if (!hasStyle) return seg.text

        return (
          <span key={seg.key} style={style}>
            {seg.text}
          </span>
        )
      })}
    </pre>
  )
}

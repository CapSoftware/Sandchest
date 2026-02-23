/** Parsed segment of ANSI text with styling information. */
interface AnsiSegment {
  text: string
  bold: boolean
  dim: boolean
  underline: boolean
  fg: string | null
  bg: string | null
}

// Standard 16-color ANSI palette mapped to Sandchest design system
const ANSI_COLORS: Record<number, string> = {
  30: 'hsl(0, 4%, 71%)',      // black → text color (visible on dark bg)
  31: 'hsl(0, 70%, 60%)',     // red
  32: 'hsl(140, 60%, 50%)',   // green
  33: 'hsl(45, 80%, 70%)',    // yellow
  34: 'hsl(210, 50%, 60%)',   // blue
  35: 'hsl(300, 40%, 65%)',   // magenta
  36: 'hsl(180, 50%, 55%)',   // cyan
  37: 'hsl(0, 4%, 71%)',      // white → text color
  90: 'hsl(0, 2%, 49%)',      // bright black (gray)
  91: 'hsl(0, 80%, 70%)',     // bright red
  92: 'hsl(62, 84%, 88%)',    // bright green → accent
  93: 'hsl(50, 90%, 80%)',    // bright yellow
  94: 'hsl(220, 60%, 70%)',   // bright blue
  95: 'hsl(310, 50%, 75%)',   // bright magenta
  96: 'hsl(190, 60%, 65%)',   // bright cyan
  97: 'hsl(0, 15%, 94%)',     // bright white → text-strong
}

const ANSI_BG_COLORS: Record<number, string> = {
  40: 'hsl(0, 9%, 7%)',       // black bg
  41: 'hsl(0, 40%, 20%)',     // red bg
  42: 'hsl(140, 30%, 15%)',   // green bg
  43: 'hsl(45, 40%, 15%)',    // yellow bg
  44: 'hsl(210, 30%, 20%)',   // blue bg
  45: 'hsl(300, 20%, 20%)',   // magenta bg
  46: 'hsl(180, 30%, 15%)',   // cyan bg
  47: 'hsl(0, 4%, 30%)',      // white bg
  100: 'hsl(0, 2%, 20%)',     // bright black bg
  101: 'hsl(0, 50%, 25%)',    // bright red bg
  102: 'hsl(140, 40%, 20%)',  // bright green bg
  103: 'hsl(50, 50%, 20%)',   // bright yellow bg
  104: 'hsl(220, 40%, 25%)',  // bright blue bg
  105: 'hsl(310, 30%, 25%)',  // bright magenta bg
  106: 'hsl(190, 40%, 20%)',  // bright cyan bg
  107: 'hsl(0, 10%, 40%)',    // bright white bg
}

// 256-color palette (colors 0-15 reuse ANSI_COLORS, 16-231 are RGB cube, 232-255 are grayscale)
function color256ToHsl(n: number): string | null {
  if (n < 0 || n > 255) return null

  // Standard colors (0-7) and bright colors (8-15)
  if (n < 8) return ANSI_COLORS[30 + n] ?? null
  if (n < 16) return ANSI_COLORS[82 + n] ?? null // 90-97

  // 216-color cube (16-231): 6x6x6 RGB
  if (n < 232) {
    const idx = n - 16
    const r = Math.floor(idx / 36)
    const g = Math.floor((idx % 36) / 6)
    const b = idx % 6
    const toVal = (v: number) => (v === 0 ? 0 : 55 + v * 40)
    return `rgb(${toVal(r)}, ${toVal(g)}, ${toVal(b)})`
  }

  // Grayscale (232-255): 24 shades
  const level = 8 + (n - 232) * 10
  return `rgb(${level}, ${level}, ${level})`
}

interface ParserState {
  bold: boolean
  dim: boolean
  underline: boolean
  fg: string | null
  bg: string | null
}

function resetState(): ParserState {
  return { bold: false, dim: false, underline: false, fg: null, bg: null }
}

/** ESC[ followed by semicolon-separated numbers, ending with 'm' */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[([0-9;]*)m/g

/**
 * Parse a string containing ANSI escape codes into styled segments.
 * Strips all non-SGR escape sequences. Handles standard colors,
 * 256-color (ESC[38;5;Nm), and truecolor (ESC[38;2;R;G;Bm).
 */
export function parseAnsi(input: string): AnsiSegment[] {
  // Strip non-SGR escape sequences (cursor movement, clearing, etc.)
  // eslint-disable-next-line no-control-regex
  const cleaned = input.replace(/\x1b\[[0-9;]*[A-HJKSTfhilnsu]/g, '')

  const segments: AnsiSegment[] = []
  let state = resetState()
  let lastIndex = 0

  ANSI_RE.lastIndex = 0
  let match = ANSI_RE.exec(cleaned)

  while (match !== null) {
    // Push text before this escape sequence
    if (match.index > lastIndex) {
      const text = cleaned.slice(lastIndex, match.index)
      if (text) {
        segments.push({ text, ...state })
      }
    }
    lastIndex = match.index + match[0].length

    // Parse SGR parameters
    const params = match[1] === '' ? [0] : match[1].split(';').map(Number)
    let i = 0

    while (i < params.length) {
      const p = params[i]!

      if (p === 0) {
        state = resetState()
      } else if (p === 1) {
        state = { ...state, bold: true }
      } else if (p === 2) {
        state = { ...state, dim: true }
      } else if (p === 4) {
        state = { ...state, underline: true }
      } else if (p === 22) {
        state = { ...state, bold: false, dim: false }
      } else if (p === 24) {
        state = { ...state, underline: false }
      } else if (p >= 30 && p <= 37) {
        state = { ...state, fg: ANSI_COLORS[p] ?? null }
      } else if (p === 39) {
        state = { ...state, fg: null }
      } else if (p >= 40 && p <= 47) {
        state = { ...state, bg: ANSI_BG_COLORS[p] ?? null }
      } else if (p === 49) {
        state = { ...state, bg: null }
      } else if (p >= 90 && p <= 97) {
        state = { ...state, fg: ANSI_COLORS[p] ?? null }
      } else if (p >= 100 && p <= 107) {
        state = { ...state, bg: ANSI_BG_COLORS[p] ?? null }
      } else if (p === 38 && i + 1 < params.length) {
        // Extended foreground: 38;5;N or 38;2;R;G;B
        const mode = params[i + 1]
        if (mode === 5 && i + 2 < params.length) {
          state = { ...state, fg: color256ToHsl(params[i + 2]!) }
          i += 2
        } else if (mode === 2 && i + 4 < params.length) {
          state = { ...state, fg: `rgb(${params[i + 2]}, ${params[i + 3]}, ${params[i + 4]})` }
          i += 4
        }
      } else if (p === 48 && i + 1 < params.length) {
        // Extended background: 48;5;N or 48;2;R;G;B
        const mode = params[i + 1]
        if (mode === 5 && i + 2 < params.length) {
          state = { ...state, bg: color256ToHsl(params[i + 2]!) }
          i += 2
        } else if (mode === 2 && i + 4 < params.length) {
          state = { ...state, bg: `rgb(${params[i + 2]}, ${params[i + 3]}, ${params[i + 4]})` }
          i += 4
        }
      }

      i++
    }

    match = ANSI_RE.exec(cleaned)
  }

  // Push remaining text after the last escape sequence
  if (lastIndex < cleaned.length) {
    const text = cleaned.slice(lastIndex)
    if (text) {
      segments.push({ text, ...state })
    }
  }

  // Merge adjacent segments with the same styling
  const merged: AnsiSegment[] = []
  for (const seg of segments) {
    const prev = merged[merged.length - 1]
    if (
      prev &&
      prev.bold === seg.bold &&
      prev.dim === seg.dim &&
      prev.underline === seg.underline &&
      prev.fg === seg.fg &&
      prev.bg === seg.bg
    ) {
      prev.text += seg.text
    } else {
      merged.push({ ...seg })
    }
  }

  return merged
}

/**
 * Compute the elapsed time label from a start timestamp.
 * Returns format like "00:00", "01:30", "1:05:30".
 */
export function formatElapsed(startIso: string, eventIso: string): string {
  const start = new Date(startIso).getTime()
  const event = new Date(eventIso).getTime()
  const diffSec = Math.max(0, Math.floor((event - start) / 1000))

  const hours = Math.floor(diffSec / 3600)
  const minutes = Math.floor((diffSec % 3600) / 60)
  const seconds = diffSec % 60

  const mm = String(minutes).padStart(2, '0')
  const ss = String(seconds).padStart(2, '0')

  if (hours > 0) {
    return `${hours}:${mm}:${ss}`
  }
  return `${mm}:${ss}`
}

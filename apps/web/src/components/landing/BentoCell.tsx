'use client'

import { useEffect, useRef } from 'react'

function getThemeColors() {
  const style = getComputedStyle(document.documentElement)
  return {
    accent: style.getPropertyValue('--color-accent').trim(),
    border: style.getPropertyValue('--color-border').trim(),
    weak: style.getPropertyValue('--color-text-weak').trim(),
    textStrong: style.getPropertyValue('--color-text-strong').trim(),
  }
}

function createCanvas(container: HTMLElement, w: number, h: number) {
  const canvas = document.createElement('canvas')
  canvas.width = w * 2
  canvas.height = h * 2
  canvas.style.width = w + 'px'
  canvas.style.height = h + 'px'
  container.appendChild(canvas)
  const ctx = canvas.getContext('2d')!
  ctx.scale(2, 2)
  return ctx
}

function initForkAnimation(container: HTMLElement) {
  const w = 200, h = 120
  const ctx = createCanvas(container, w, h)
  const { accent } = getThemeColors()
  let t = 0
  let raf: number
  function draw() {
    ctx.clearRect(0, 0, w, h)
    const progress = (Math.sin(t * 0.01) + 1) / 2
    ctx.strokeStyle = accent; ctx.lineWidth = 1.5; ctx.lineCap = 'round'
    const trunkH = 35, trunkStart = h - 15, centerX = w / 2
    ctx.beginPath(); ctx.moveTo(centerX, trunkStart); ctx.lineTo(centerX, trunkStart - trunkH); ctx.stroke()
    ctx.fillStyle = accent; ctx.beginPath(); ctx.arc(centerX, trunkStart - trunkH, 3, 0, Math.PI * 2); ctx.fill()
    const branchLen = 30 + progress * 20, branchAngle = 0.5 + progress * 0.3
    ctx.strokeStyle = accent
    ctx.beginPath(); ctx.moveTo(centerX, trunkStart - trunkH); ctx.lineTo(centerX - Math.sin(branchAngle) * branchLen, trunkStart - trunkH - Math.cos(branchAngle) * branchLen); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(centerX, trunkStart - trunkH); ctx.lineTo(centerX + Math.sin(branchAngle) * branchLen, trunkStart - trunkH - Math.cos(branchAngle) * branchLen); ctx.stroke()
    const dotSize = 2 + progress * 1.5
    ctx.fillStyle = accent
    ctx.beginPath(); ctx.arc(centerX - Math.sin(branchAngle) * branchLen, trunkStart - trunkH - Math.cos(branchAngle) * branchLen, dotSize, 0, Math.PI * 2); ctx.fill()
    ctx.beginPath(); ctx.arc(centerX + Math.sin(branchAngle) * branchLen, trunkStart - trunkH - Math.cos(branchAngle) * branchLen, dotSize, 0, Math.PI * 2); ctx.fill()
    const particleY = (trunkStart - trunkH) - (progress * 30)
    ctx.globalAlpha = 1 - progress; ctx.fillStyle = accent; ctx.beginPath(); ctx.arc(centerX, particleY, 1.5, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1
    t++; raf = requestAnimationFrame(draw)
  }
  draw()
  return () => cancelAnimationFrame(raf)
}

function initShieldAnimation(container: HTMLElement) {
  const w = 200, h = 120
  const ctx = createCanvas(container, w, h)
  const { accent, border } = getThemeColors()
  let t = 0; let raf: number
  function draw() {
    ctx.clearRect(0, 0, w, h)
    const cx = w / 2, cy = h / 2
    for (let i = 0; i < 3; i++) {
      const phase = (t * 0.008 + i * 0.8) % (Math.PI * 2)
      const pulse = Math.sin(phase) * 0.3 + 0.7
      const size = 16 + i * 14
      ctx.strokeStyle = i === 0 ? accent : border
      ctx.globalAlpha = (0.8 - i * 0.25) * pulse
      ctx.lineWidth = i === 0 ? 1.5 : 1
      const sw = size, sh = size * 1.15
      ctx.beginPath(); ctx.moveTo(cx, cy - sh)
      ctx.bezierCurveTo(cx + sw, cy - sh * 0.6, cx + sw, cy + sh * 0.2, cx, cy + sh)
      ctx.bezierCurveTo(cx - sw, cy + sh * 0.2, cx - sw, cy - sh * 0.6, cx, cy - sh)
      ctx.stroke()
    }
    ctx.globalAlpha = 0.6 + Math.sin(t * 0.015) * 0.4; ctx.fillStyle = accent; ctx.beginPath(); ctx.arc(cx, cy - 2, 2.5, 0, Math.PI * 2); ctx.fill()
    ctx.globalAlpha = 1; t++; raf = requestAnimationFrame(draw)
  }
  draw()
  return () => cancelAnimationFrame(raf)
}

function initSdkAnimation(container: HTMLElement) {
  const w = 200, h = 120
  const ctx = createCanvas(container, w, h)
  const { accent, weak } = getThemeColors()
  const symbols = ['{ }', '( )', '=>', '[ ]', 'fn', '< />']
  const particles = symbols.map((s, i) => ({
    text: s,
    baseX: 30 + (i % 3) * 60 + Math.random() * 20,
    baseY: 25 + Math.floor(i / 3) * 50 + Math.random() * 10,
    phase: Math.random() * Math.PI * 2,
    speed: 0.004 + Math.random() * 0.004,
  }))
  let t = 0; let raf: number
  function draw() {
    ctx.clearRect(0, 0, w, h)
    ctx.font = '13px "Geist Mono", monospace'; ctx.textAlign = 'center'
    particles.forEach((p, i) => {
      const x = p.baseX + Math.sin(t * p.speed + p.phase) * 8
      const y = p.baseY + Math.cos(t * p.speed * 1.3 + p.phase) * 6
      ctx.globalAlpha = 0.3 + Math.sin(t * 0.01 + i) * 0.2 + 0.2
      ctx.fillStyle = i % 2 === 0 ? accent : weak
      ctx.fillText(p.text, x, y)
    })
    ctx.globalAlpha = 1; t++; raf = requestAnimationFrame(draw)
  }
  draw()
  return () => cancelAnimationFrame(raf)
}

function initReplayAnimation(container: HTMLElement) {
  const w = 200, h = 120
  const ctx = createCanvas(container, w, h)
  const { accent, border, weak } = getThemeColors()
  const events = [25, 55, 80, 105, 130, 155, 170]
  let t = 0; let raf: number
  function draw() {
    ctx.clearRect(0, 0, w, h)
    const lineY = h / 2 + 10, lineStart = 20, lineEnd = w - 20
    ctx.strokeStyle = border; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(lineStart, lineY); ctx.lineTo(lineEnd, lineY); ctx.stroke()
    events.forEach(x => { ctx.fillStyle = border; ctx.beginPath(); ctx.arc(x, lineY, 2, 0, Math.PI * 2); ctx.fill() })
    const progress = (Math.sin(t * 0.006) + 1) / 2
    const playheadX = lineStart + progress * (lineEnd - lineStart)
    ctx.strokeStyle = accent; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(lineStart, lineY); ctx.lineTo(playheadX, lineY); ctx.stroke()
    events.forEach(x => { if (x <= playheadX) { ctx.fillStyle = accent; ctx.beginPath(); ctx.arc(x, lineY, 2.5, 0, Math.PI * 2); ctx.fill() } })
    ctx.fillStyle = accent; ctx.beginPath(); ctx.arc(playheadX, lineY, 5, 0, Math.PI * 2); ctx.fill()
    ctx.globalAlpha = 0.15; ctx.beginPath(); ctx.arc(playheadX, lineY, 12, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1
    const termY = lineY - 35
    for (let i = 0; i < 4; i++) {
      const lx = 35, ly = termY + i * 10, lw = 30 + (i * 17) % 40
      const lineProgress = (playheadX - lineStart) / (lineEnd - lineStart)
      ctx.globalAlpha = Math.max(0, Math.min(1, (lineProgress - i * 0.15) * 2)) * 0.5
      ctx.fillStyle = weak; ctx.fillRect(lx, ly, lw, 2)
    }
    ctx.globalAlpha = 1; t++; raf = requestAnimationFrame(draw)
  }
  draw()
  return () => cancelAnimationFrame(raf)
}

function initMcpAnimation(container: HTMLElement) {
  const w = 200, h = 120
  const ctx = createCanvas(container, w, h)
  const { accent, border, weak } = getThemeColors()
  const nodes = [
    { angle: 0, radius: 38, size: 4 },
    { angle: Math.PI * 0.6, radius: 35, size: 3.5 },
    { angle: Math.PI * 1.2, radius: 40, size: 3 },
    { angle: Math.PI * 1.7, radius: 32, size: 3.5 },
  ]
  let t = 0; let raf: number
  function draw() {
    ctx.clearRect(0, 0, w, h)
    const cx = w / 2, cy = h / 2
    ctx.fillStyle = accent; ctx.beginPath(); ctx.arc(cx, cy, 5, 0, Math.PI * 2); ctx.fill()
    ctx.globalAlpha = 0.08 + Math.sin(t * 0.015) * 0.05; ctx.beginPath(); ctx.arc(cx, cy, 18, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1
    nodes.forEach((node, i) => {
      const a = node.angle + t * 0.004
      const nx = cx + Math.cos(a) * node.radius, ny = cy + Math.sin(a) * node.radius
      ctx.strokeStyle = border; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(nx, ny); ctx.stroke()
      const packetProgress = (Math.sin(t * 0.012 + i * 1.5) + 1) / 2
      const px = cx + (nx - cx) * packetProgress, py = cy + (ny - cy) * packetProgress
      ctx.fillStyle = accent; ctx.globalAlpha = 0.6; ctx.beginPath(); ctx.arc(px, py, 1.5, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1
      ctx.fillStyle = weak; ctx.beginPath(); ctx.arc(nx, ny, node.size, 0, Math.PI * 2); ctx.fill()
    })
    t++; raf = requestAnimationFrame(draw)
  }
  draw()
  return () => cancelAnimationFrame(raf)
}

function initCliAnimation(container: HTMLElement) {
  const w = 200, h = 120
  const ctx = createCanvas(container, w, h)
  const { accent, weak, textStrong } = getThemeColors()
  const cmds = ['$ sandchest create', '$ sandchest exec "npm test"', '$ sandchest fork sb_3kx']
  let t = 0; let raf: number
  function draw() {
    ctx.clearRect(0, 0, w, h)
    ctx.font = '11px "Geist Mono", monospace'; ctx.textAlign = 'left'
    const cycleLen = 380
    const cmdIndex = Math.floor(t / cycleLen) % cmds.length
    const cmdProgress = (t % cycleLen) / cycleLen
    for (let i = 0; i < cmdIndex && i < 2; i++) {
      ctx.globalAlpha = 0.3; ctx.fillStyle = weak; ctx.fillText(cmds[i], 20, 35 + i * 22)
    }
    const cmd = cmds[cmdIndex]
    const visibleChars = Math.min(cmd.length, Math.floor(cmdProgress * cmd.length * 1.2))
    const typedText = cmd.substring(0, visibleChars)
    const y = 35 + Math.min(cmdIndex, 2) * 22
    ctx.globalAlpha = 1
    if (typedText.length > 0) {
      ctx.fillStyle = accent; ctx.fillText('$', 20, y)
      ctx.fillStyle = textStrong; ctx.fillText(typedText.substring(1), 20 + ctx.measureText('$').width, y)
    }
    const cursorOn = Math.sin(t * 0.04) > 0
    if (cursorOn && cmdProgress < 0.7) {
      const cursorX = 20 + ctx.measureText(typedText).width + 2
      ctx.fillStyle = accent; ctx.fillRect(cursorX, y - 9, 6, 12)
    }
    if (cmdProgress > 0.7) {
      const outputAlpha = Math.min(1, (cmdProgress - 0.7) * 4)
      ctx.globalAlpha = outputAlpha * 0.4; ctx.fillStyle = weak
      const outputs = ['sandbox sb_3kx created', 'exit code: 0', 'forked → sb_7mq']
      ctx.fillText(outputs[cmdIndex], 26, y + 18)
    }
    ctx.globalAlpha = 1; t++; raf = requestAnimationFrame(draw)
  }
  draw()
  return () => cancelAnimationFrame(raf)
}

function initSessionAnimation(container: HTMLElement) {
  const w = 200, h = 120
  const ctx = createCanvas(container, w, h)
  const { accent, textStrong } = getThemeColors()
  let t = 0; let raf: number
  const cmds = ['cd /app', 'export K=v', 'echo $K']
  function draw() {
    ctx.clearRect(0, 0, w, h)
    const barX = 28
    const pulse = Math.sin(t * 0.01) * 0.2 + 0.6
    ctx.strokeStyle = accent; ctx.lineWidth = 1.5; ctx.globalAlpha = pulse
    ctx.beginPath(); ctx.moveTo(barX, 22); ctx.lineTo(barX, 98); ctx.stroke()
    ctx.fillStyle = accent; ctx.globalAlpha = pulse * 1.2
    ctx.beginPath(); ctx.arc(barX, 16, 3, 0, Math.PI * 2); ctx.fill()
    const dotY = 22 + ((t * 0.2) % 76)
    ctx.fillStyle = accent; ctx.globalAlpha = 0.5 * (1 - (dotY - 22) / 76)
    ctx.beginPath(); ctx.arc(barX, dotY, 1.5, 0, Math.PI * 2); ctx.fill()
    const dot2Y = 22 + ((t * 0.2 + 38) % 76)
    ctx.globalAlpha = 0.4 * (1 - (dot2Y - 22) / 76)
    ctx.beginPath(); ctx.arc(barX, dot2Y, 1.5, 0, Math.PI * 2); ctx.fill()
    ctx.globalAlpha = 1
    ctx.font = '10px "Geist Mono", monospace'; ctx.textAlign = 'left'
    const cycleLen = 440; const progress = (t % cycleLen) / cycleLen
    cmds.forEach((cmd, i) => {
      const y = 30 + i * 26; const start = i * 0.25
      if (progress < start) return
      const p = Math.min(1, (progress - start) / 0.3)
      const chars = Math.floor(p * cmd.length)
      ctx.fillStyle = accent; ctx.globalAlpha = 0.9
      ctx.beginPath(); ctx.arc(barX, y, 3.5, 0, Math.PI * 2); ctx.fill()
      ctx.globalAlpha = 0.5 + p * 0.5; ctx.fillStyle = textStrong
      ctx.fillText(cmd.substring(0, chars), barX + 14, y + 3)
      if (i === 2 && p >= 1) {
        const outAlpha = Math.min(1, (progress - start - 0.3) * 5)
        ctx.globalAlpha = outAlpha * 0.5; ctx.fillStyle = accent
        ctx.fillText('→ v', barX + 14, y + 16)
      }
      ctx.globalAlpha = 1
    })
    t++; raf = requestAnimationFrame(draw)
  }
  draw()
  return () => cancelAnimationFrame(raf)
}

function initRuntimesAnimation(container: HTMLElement) {
  const w = 200, h = 120
  const ctx = createCanvas(container, w, h)
  const { accent, border, weak } = getThemeColors()
  const runtimes = [
    { name: 'node', x: w / 2 - 34, y: h / 2 - 20 },
    { name: 'bun', x: w / 2 + 34, y: h / 2 - 20 },
    { name: 'python', x: w / 2 - 34, y: h / 2 + 20 },
    { name: 'go', x: w / 2 + 34, y: h / 2 + 20 },
  ]
  let t = 0; let raf: number
  function draw() {
    ctx.clearRect(0, 0, w, h)
    const activeIndex = Math.floor(t / 300) % runtimes.length
    const phase = (t % 300) / 300
    runtimes.forEach((rt, i) => {
      const isActive = i === activeIndex
      const isNext = i === (activeIndex + 1) % runtimes.length
      const bw = 52, bh = 22
      let alpha = 0.3, lineW = 1, color = border, textColor = weak
      if (isActive) {
        const fade = phase > 0.8 ? 1 - (phase - 0.8) / 0.2 : 1
        alpha = 0.5 + fade * 0.4; lineW = 1.5; color = accent; textColor = accent
      } else if (isNext && phase > 0.8) {
        const fadeIn = (phase - 0.8) / 0.2
        alpha = 0.3 + fadeIn * 0.5; lineW = 1 + fadeIn * 0.5; color = accent; textColor = accent
      }
      ctx.strokeStyle = color; ctx.lineWidth = lineW; ctx.globalAlpha = alpha
      ctx.beginPath(); ctx.roundRect(rt.x - bw / 2, rt.y - bh / 2, bw, bh, 4); ctx.stroke()
      if (isActive) {
        const glow = Math.sin(t * 0.015) * 0.03 + 0.04
        ctx.fillStyle = accent; ctx.globalAlpha = glow * (phase > 0.8 ? 1 - (phase - 0.8) / 0.2 : 1)
        ctx.beginPath(); ctx.roundRect(rt.x - bw / 2 - 3, rt.y - bh / 2 - 3, bw + 6, bh + 6, 6); ctx.fill()
      }
      ctx.font = '11px "Geist Mono", monospace'; ctx.textAlign = 'center'
      ctx.fillStyle = textColor; ctx.globalAlpha = alpha
      ctx.fillText(rt.name, rt.x, rt.y + 4)
      ctx.globalAlpha = 1
    })
    t++; raf = requestAnimationFrame(draw)
  }
  draw()
  return () => cancelAnimationFrame(raf)
}

function initArtifactsAnimation(container: HTMLElement) {
  const w = 200, h = 120
  const ctx = createCanvas(container, w, h)
  const { accent, border, weak } = getThemeColors()
  let t = 0; let raf: number
  const files = [
    { targetX: w / 2 - 12, targetY: 82, fw: 38, delay: 0 },
    { targetX: w / 2 - 8, targetY: 68, fw: 32, delay: 0.15 },
    { targetX: w / 2 - 14, targetY: 54, fw: 42, delay: 0.3 },
    { targetX: w / 2 - 6, targetY: 40, fw: 28, delay: 0.45 },
  ]
  function draw() {
    ctx.clearRect(0, 0, w, h)
    const cycleLen = 720; const progress = (t % cycleLen) / cycleLen
    ctx.strokeStyle = border; ctx.lineWidth = 1; ctx.globalAlpha = 0.3
    ctx.beginPath(); ctx.roundRect(w / 2 - 28, 32, 56, 62, 4); ctx.stroke()
    ctx.globalAlpha = 1
    files.forEach((file, i) => {
      if (progress < file.delay) return
      const p = Math.min(1, (progress - file.delay) / 0.25)
      const ease = 1 - Math.pow(1 - p, 3)
      const startX = -30, startY = file.targetY - 15
      const x = startX + (file.targetX - startX) * ease
      const y = startY + (file.targetY - startY) * ease
      ctx.strokeStyle = i === 0 ? accent : weak; ctx.lineWidth = 1
      ctx.globalAlpha = 0.3 + p * 0.5
      ctx.beginPath(); ctx.roundRect(x, y, file.fw, 10, 2); ctx.stroke()
      ctx.fillStyle = i === 0 ? accent : border; ctx.globalAlpha = 0.08 + p * 0.12
      ctx.beginPath(); ctx.roundRect(x, y, file.fw, 10, 2); ctx.fill()
      ctx.globalAlpha = 1
    })
    if (progress > 0.85) {
      const a = Math.min(1, (progress - 0.85) / 0.12) * (Math.sin(t * 0.02) * 0.2 + 0.8)
      const ax = w / 2, ay = 22
      ctx.strokeStyle = accent; ctx.lineWidth = 1.5; ctx.globalAlpha = a
      ctx.beginPath(); ctx.moveTo(ax, ay - 8); ctx.lineTo(ax, ay + 3); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(ax - 4, ay - 1); ctx.lineTo(ax, ay + 3); ctx.lineTo(ax + 4, ay - 1); ctx.stroke()
      ctx.globalAlpha = 1
    }
    t++; raf = requestAnimationFrame(draw)
  }
  draw()
  return () => cancelAnimationFrame(raf)
}

const animationInits: Record<string, (el: HTMLElement) => () => void> = {
  'fork-anim': initForkAnimation,
  'shield-anim': initShieldAnimation,
  'sdk-anim': initSdkAnimation,
  'replay-anim': initReplayAnimation,
  'mcp-anim': initMcpAnimation,
  'cli-anim': initCliAnimation,
  'session-anim': initSessionAnimation,
  'runtimes-anim': initRuntimesAnimation,
  'artifacts-anim': initArtifactsAnimation,
}

interface BentoCellProps {
  title: string
  description: string
  animationId: string
}

export default function BentoCell({ title, description, animationId }: BentoCellProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const init = animationInits[animationId]
    if (!init) return
    return init(el)
  }, [animationId])

  return (
    <div className="bento-cell">
      <div className="bento-animation" ref={containerRef} />
      <div className="bento-content">
        <h4 className="bento-title">{title}</h4>
        <p className="bento-desc">{description}</p>
      </div>
    </div>
  )
}

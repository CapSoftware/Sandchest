'use client'

import { useEffect, useRef } from 'react'

export default function CtaAnimation() {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const canvas = document.createElement('canvas')
    const w = 240, h = 180
    canvas.width = w * 2; canvas.height = h * 2
    canvas.style.width = w + 'px'; canvas.style.height = h + 'px'
    container.appendChild(canvas)
    const ctx = canvas.getContext('2d')!
    ctx.scale(2, 2)

    const style = getComputedStyle(document.documentElement)
    const accent = style.getPropertyValue('--color-accent').trim()
    const border = style.getPropertyValue('--color-border').trim()

    function drawStar(cx: number, cy: number, outerR: number, innerR: number, points: number) {
      ctx.beginPath()
      for (let i = 0; i < points * 2; i++) {
        const r = i % 2 === 0 ? outerR : innerR
        const a = (i * Math.PI) / points - Math.PI / 2
        const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
      }
      ctx.closePath()
    }

    interface Particle { x: number; y: number; vx: number; vy: number; life: number; maxLife: number; size: number }
    const particles: Particle[] = []
    let lastBurst = 0

    function burst(cx: number, cy: number) {
      for (let i = 0; i < 8; i++) {
        const angle = (Math.PI * 2 * i) / 8 + (Math.random() - 0.5) * 0.5
        const speed = 0.4 + Math.random() * 0.6
        particles.push({ x: cx, y: cy, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, life: 0, maxLife: 60 + Math.random() * 40, size: 1 + Math.random() * 1.5 })
      }
    }

    let t = 0; let raf: number
    function draw() {
      ctx.clearRect(0, 0, w, h)
      const cx = w / 2, cy = h / 2
      const pulse = Math.sin(t * 0.02) * 0.5 + 0.5
      if (pulse > 0.95 && t - lastBurst > 60) { burst(cx, cy); lastBurst = t }
      for (let i = 0; i < 5; i++) {
        const angle = t * 0.006 + (i * Math.PI * 2) / 5
        const orbitR = 55 + Math.sin(t * 0.01 + i) * 8
        const sx = cx + Math.cos(angle) * orbitR, sy = cy + Math.sin(angle) * orbitR
        const starSize = 2.5 + Math.sin(t * 0.03 + i * 2) * 1
        ctx.fillStyle = border; ctx.globalAlpha = 0.4 + Math.sin(t * 0.025 + i) * 0.2
        drawStar(sx, sy, starSize, starSize * 0.4, 5); ctx.fill()
      }
      ctx.globalAlpha = 1
      for (let ring = 2; ring >= 0; ring--) {
        const ringR = 22 + ring * 10 + pulse * 6
        ctx.globalAlpha = (0.04 - ring * 0.01) * (0.5 + pulse * 0.5); ctx.fillStyle = accent
        ctx.beginPath(); ctx.arc(cx, cy, ringR, 0, Math.PI * 2); ctx.fill()
      }
      ctx.globalAlpha = 1
      const mainR = 16 + pulse * 3, innerR = mainR * 0.4
      ctx.fillStyle = accent; ctx.globalAlpha = 0.15 + pulse * 0.1; drawStar(cx, cy, mainR, innerR, 5); ctx.fill()
      ctx.strokeStyle = accent; ctx.lineWidth = 1.5; ctx.globalAlpha = 0.7 + pulse * 0.3; drawStar(cx, cy, mainR, innerR, 5); ctx.stroke()
      ctx.globalAlpha = 1
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i]; p.x += p.vx; p.y += p.vy; p.vy -= 0.002; p.life++
        const lifeProgress = p.life / p.maxLife
        if (lifeProgress >= 1) { particles.splice(i, 1); continue }
        ctx.globalAlpha = (1 - lifeProgress) * 0.6; ctx.fillStyle = accent
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (1 - lifeProgress * 0.5), 0, Math.PI * 2); ctx.fill()
      }
      ctx.globalAlpha = 1; t++; raf = requestAnimationFrame(draw)
    }
    draw()
    return () => { cancelAnimationFrame(raf); container.innerHTML = '' }
  }, [])

  return <div className="cta-animation" ref={containerRef} />
}

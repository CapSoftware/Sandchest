'use client'

import { useEffect, useRef } from 'react'
import { competitors, SANDCHEST_TIERS, sandboxPerHr, freePlan, paidPlan } from '@/data/pricing'

// Standard small sandbox: 2 vCPU, 4 GiB RAM, 20 GiB storage
const COMP_PER_HR = sandboxPerHr(competitors.e2b.rates.vcpuPerHr, competitors.e2b.rates.ramGiBPerHr)

const E2B_PRO_FEE = paidPlan(competitors.e2b)?.monthlyPrice ?? 0

const daytonaFreePlan = freePlan(competitors.daytona)
const DAYTONA_STORAGE_MONTHLY =
  competitors.daytona.rates.storageGiBPerHr != null
    ? Math.max(0, 20 - daytonaFreePlan.storageFreeGiB) * competitors.daytona.rates.storageGiBPerHr * 720
    : 0

const SC_MAX_BASE = SANDCHEST_TIERS.max.monthlyBase
const SC_MAX_PER_HR = sandboxPerHr(SANDCHEST_TIERS.max.vcpuPerHr, SANDCHEST_TIERS.max.ramGiBPerHr)
const SC_MAX_CREDITS = SANDCHEST_TIERS.max.monthlyCredits

const MAX_HOURS = 1200
const MAX_COST = 400

function getThemeColors() {
  const style = getComputedStyle(document.documentElement)
  return {
    accent: style.getPropertyValue('--color-accent').trim(),
    border: style.getPropertyValue('--color-border').trim(),
    weak: style.getPropertyValue('--color-text-weak').trim(),
    surface: style.getPropertyValue('--color-surface').trim(),
    borderWeak: style.getPropertyValue('--color-border-weak').trim(),
  }
}

// E2B Pro: $150/mo platform fee
function e2bProCost(hours: number) {
  return E2B_PRO_FEE + hours * COMP_PER_HR
}

function daytonaCost(hours: number) {
  return hours * COMP_PER_HR + DAYTONA_STORAGE_MONTHLY
}

function sandchestMaxCost(hours: number) {
  const usage = hours * SC_MAX_PER_HR
  return SC_MAX_BASE + Math.max(0, usage - SC_MAX_CREDITS)
}

export default function CostRaceAnimation() {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const canvas = document.createElement('canvas')
    const w = 740
    const h = 380
    canvas.width = w * 2
    canvas.height = h * 2
    canvas.style.width = '100%'
    canvas.style.maxWidth = w + 'px'
    canvas.style.height = 'auto'
    el.appendChild(canvas)
    const ctx = canvas.getContext('2d')!
    ctx.scale(2, 2)

    const colors = getThemeColors()

    let progress = 0
    let started = false
    let raf: number

    const padLeft = 60
    const padRight = 150
    const padTop = 24
    const padBottom = 72
    const plotW = w - padLeft - padRight
    const plotH = h - padTop - padBottom

    function xPos(hours: number) {
      return padLeft + (hours / MAX_HOURS) * plotW
    }

    function yPos(cost: number) {
      return padTop + plotH - (cost / MAX_COST) * plotH
    }

    function drawLine(
      costFn: (h: number) => number,
      color: string,
      label: string,
      maxHr: number,
      opts?: { dashed?: boolean; labelOffsetY?: number; lineWidth?: number },
    ) {
      ctx.strokeStyle = color
      ctx.lineWidth = opts?.lineWidth ?? 2.5
      if (opts?.dashed) ctx.setLineDash([8, 5])
      ctx.beginPath()
      for (let hr = 0; hr <= maxHr; hr += 2) {
        const x = xPos(hr)
        const y = yPos(costFn(hr))
        if (hr === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.stroke()
      ctx.setLineDash([])

      // End dot
      if (maxHr > 0) {
        const dotX = xPos(maxHr)
        const dotY = yPos(costFn(maxHr))
        ctx.beginPath()
        ctx.arc(dotX, dotY, 4, 0, Math.PI * 2)
        ctx.fillStyle = color
        ctx.fill()
      }

      // End label
      const endCost = costFn(maxHr)
      const lx = xPos(maxHr) + 10
      const ly = yPos(endCost) + (opts?.labelOffsetY ?? 0)
      ctx.fillStyle = color
      ctx.font = 'bold 12px "Geist Mono", monospace'
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      ctx.fillText(label, lx, ly)
      ctx.font = '12px "Geist Mono", monospace'
      ctx.fillText('$' + Math.round(endCost), lx, ly + 15)
    }

    function draw() {
      ctx.clearRect(0, 0, w, h)

      // Grid lines
      ctx.strokeStyle = colors.borderWeak
      ctx.lineWidth = 0.5
      for (let c = 0; c <= MAX_COST; c += 50) {
        const y = yPos(c)
        ctx.beginPath()
        ctx.moveTo(padLeft, y)
        ctx.lineTo(padLeft + plotW, y)
        ctx.stroke()
      }

      // Axes
      ctx.strokeStyle = colors.border
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(padLeft, padTop)
      ctx.lineTo(padLeft, padTop + plotH)
      ctx.lineTo(padLeft + plotW, padTop + plotH)
      ctx.stroke()

      // Y-axis labels
      ctx.fillStyle = colors.weak
      ctx.font = '12px "Geist Mono", monospace'
      ctx.textAlign = 'right'
      ctx.textBaseline = 'middle'
      for (let c = 0; c <= MAX_COST; c += 100) {
        ctx.fillText('$' + c, padLeft - 10, yPos(c))
      }

      // X-axis labels
      ctx.textAlign = 'center'
      ctx.textBaseline = 'top'
      for (let hr = 0; hr <= MAX_HOURS; hr += 200) {
        ctx.fillText(hr + 'h', xPos(hr), padTop + plotH + 10)
      }

      // Axis titles
      ctx.fillStyle = colors.weak
      ctx.font = '12px "Geist Mono", monospace'
      ctx.textAlign = 'center'
      ctx.fillText('sandbox-hours / month (2 vCPU, 4 GiB)', padLeft + plotW / 2, h - 6)

      // Lines
      const currentMaxHr = progress * MAX_HOURS

      drawLine(e2bProCost, colors.border, 'E2B Pro', currentMaxHr, {
        labelOffsetY: -12,
      })
      drawLine(daytonaCost, colors.weak, 'E2B / Daytona', currentMaxHr, {
        dashed: true,
        labelOffsetY: 4,
      })
      drawLine(sandchestMaxCost, colors.accent, 'Sandchest Max', currentMaxHr, {
        lineWidth: 3,
      })

      if (progress < 1) {
        progress += 0.006
        if (progress > 1) progress = 1
        raf = requestAnimationFrame(draw)
      }
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !started) {
          started = true
          draw()
        }
      },
      { threshold: 0.2 },
    )

    observer.observe(el)

    return () => {
      observer.disconnect()
      cancelAnimationFrame(raf)
      if (canvas.parentNode) canvas.parentNode.removeChild(canvas)
    }
  }, [])

  return (
    <div className="section">
      <div className="section-header">
        <h3 className="section-title">Cost at scale</h3>
        <p className="text-text-weak" style={{ fontSize: 13 }}>
          Total monthly cost for a standard small sandbox (2 vCPU, 4 GiB). E2B Hobby and Daytona share the same compute rates; E2B Pro adds a $150/mo platform fee.
        </p>
      </div>
      <div className="cost-race-container" ref={containerRef} />
    </div>
  )
}

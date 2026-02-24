'use client'

import { useState } from 'react'
import { PROVISION_STEPS } from '@/lib/provisioner'

interface StepData {
  id: string
  status: string
  output?: string | undefined
}

function StepIcon({ status }: { status: string }) {
  let label = ''
  if (status === 'completed') label = '\u2713'
  else if (status === 'running') label = '\u25B6'
  else if (status === 'failed') label = '\u2717'
  else label = '\u2022'

  return (
    <div className="provision-step-icon" data-status={status}>
      {label}
    </div>
  )
}

export default function ProvisionSteps({
  steps,
  onRetry,
  retrying,
}: {
  steps: StepData[] | null
  onRetry?: (() => void) | undefined
  retrying?: boolean | undefined
}) {
  const [expandedStep, setExpandedStep] = useState<string | null>(null)

  const parsed: StepData[] = Array.isArray(steps)
    ? steps
    : typeof steps === 'string'
      ? (JSON.parse(steps) as StepData[])
      : []
  const stepMap = new Map(parsed.map((s) => [s.id, s]))

  return (
    <div className="provision-timeline">
      {PROVISION_STEPS.map((step) => {
        const result = stepMap.get(step.id)
        const status = result?.status ?? 'pending'
        const isExpanded = expandedStep === step.id

        return (
          <div key={step.id} className="provision-step">
            <StepIcon status={status} />
            <div
              style={{ cursor: result?.output ? 'pointer' : 'default' }}
              onClick={() => {
                if (result?.output) {
                  setExpandedStep(isExpanded ? null : step.id)
                }
              }}
            >
              <div className="provision-step-name">
                {step.name}
                {status === 'running' && <span className="spinner" style={{ marginLeft: '0.5rem', width: '0.75rem', height: '0.75rem' }} />}
              </div>
              {status === 'failed' && result?.output && (
                <div className="provision-step-output">{result.output}</div>
              )}
              {isExpanded && status !== 'failed' && result?.output && (
                <div className="provision-step-output">{result.output}</div>
              )}
              {status === 'failed' && onRetry && (
                <button
                  className="btn btn-sm"
                  style={{ marginTop: '0.5rem' }}
                  onClick={(e) => {
                    e.stopPropagation()
                    onRetry()
                  }}
                  disabled={retrying}
                >
                  {retrying ? <span className="spinner" /> : 'Retry from here'}
                </button>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

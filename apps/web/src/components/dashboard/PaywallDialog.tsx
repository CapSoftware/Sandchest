'use client'

import {
  createContext,
  useContext,
  useState,
  useRef,
  useEffect,
  useCallback,
} from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { useBillingCheck } from '@/hooks/use-billing-check'

type PaywallState = {
  open: boolean
  featureId: string
  featureName: string
}

type PaywallContextValue = {
  openPaywall: (featureId: string, featureName: string) => void
  closePaywall: () => void
}

const PaywallContext = createContext<PaywallContextValue | null>(null)

export function usePaywall(): PaywallContextValue {
  const ctx = useContext(PaywallContext)
  if (!ctx) throw new Error('usePaywall must be used within PaywallProvider')
  return ctx
}

/**
 * Check feature access and return a gate function.
 * Call `gate()` before gated actions — returns true if allowed,
 * opens the paywall dialog and returns false if not.
 */
export function useFeatureGate(featureId: string, featureName: string) {
  const billing = useBillingCheck(featureId)
  const { openPaywall } = usePaywall()

  const gate = useCallback((): boolean => {
    if (billing.allowed) return true
    openPaywall(featureId, featureName)
    return false
  }, [billing.allowed, featureId, featureName, openPaywall])

  return { ...billing, gate }
}

/**
 * Returns true if the error is a 403 billing limit error from the API.
 */
export function isBillingLimitError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return (
    'status' in error &&
    (error as Error & { status: number }).status === 403
  )
}

function PaywallDialogContent({
  featureId,
  featureName,
  dismiss,
}: {
  featureId: string
  featureName: string
  dismiss: () => void
}) {
  const params = useParams<{ orgSlug: string }>()
  const { balance, usage } = useBillingCheck(featureId)
  const overlayRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') dismiss()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [dismiss])

  useEffect(() => {
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = ''
    }
  }, [])

  function handleOverlayClick(e: React.MouseEvent) {
    if (e.target === overlayRef.current) dismiss()
  }

  const used = usage ?? 0
  const limit = balance != null ? used + balance : null

  return (
    <div
      className="paywall-overlay"
      ref={overlayRef}
      onClick={handleOverlayClick}
      role="dialog"
      aria-modal="true"
      aria-label="Upgrade required"
    >
      <div className="paywall-dialog">
        <div className="paywall-header">
          <h2 className="paywall-title">Limit reached</h2>
          <button className="paywall-close" onClick={dismiss} aria-label="Close">
            <svg
              width="14"
              height="14"
              viewBox="0 0 14 14"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            >
              <path d="M3 3l8 8M11 3l-8 8" />
            </svg>
          </button>
        </div>

        <p className="paywall-message">
          You&apos;ve reached the limit for <strong>{featureName}</strong> on
          your current plan.
        </p>

        {limit != null && (
          <div className="paywall-usage">
            <div className="paywall-usage-label">
              <span>{featureName}</span>
              <span className="paywall-usage-value">
                {used.toLocaleString()} / {limit.toLocaleString()}
              </span>
            </div>
            <div className="paywall-usage-bar">
              <div className="paywall-usage-fill" style={{ width: '100%' }} />
            </div>
          </div>
        )}

        <p className="paywall-sub">
          Upgrade your plan to unlock more {featureName.toLowerCase()}.
        </p>

        <div className="paywall-actions">
          <Link
            href={`/dashboard/${params.orgSlug}/billing`}
            className="paywall-upgrade-btn"
            onClick={dismiss}
          >
            Upgrade plan
          </Link>
          <button className="paywall-dismiss-btn" onClick={dismiss}>
            Maybe later
          </button>
        </div>
      </div>
    </div>
  )
}

export function PaywallProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<PaywallState>({
    open: false,
    featureId: '',
    featureName: '',
  })

  const openPaywall = useCallback((featureId: string, featureName: string) => {
    setState({ open: true, featureId, featureName })
  }, [])

  const closePaywall = useCallback(() => {
    setState((prev) => ({ ...prev, open: false }))
  }, [])

  return (
    <PaywallContext.Provider value={{ openPaywall, closePaywall }}>
      {children}
      {state.open && (
        <PaywallDialogContent
          featureId={state.featureId}
          featureName={state.featureName}
          dismiss={closePaywall}
        />
      )}
    </PaywallContext.Provider>
  )
}

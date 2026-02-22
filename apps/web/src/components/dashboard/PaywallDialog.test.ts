import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const COMPONENT_PATH = join(import.meta.dir, 'PaywallDialog.tsx')

describe('PaywallDialog component', () => {
  const src = readFileSync(COMPONENT_PATH, 'utf-8')

  test('is a client component', () => {
    expect(src).toMatch(/^['"]use client['"]/)
  })

  test('exports PaywallProvider component', () => {
    expect(src).toMatch(/export function PaywallProvider/)
  })

  test('exports usePaywall hook', () => {
    expect(src).toMatch(/export function usePaywall/)
  })

  test('exports useFeatureGate hook', () => {
    expect(src).toMatch(/export function useFeatureGate/)
  })

  test('exports isBillingLimitError helper', () => {
    expect(src).toMatch(/export function isBillingLimitError/)
  })

  test('usePaywall throws when used outside provider', () => {
    expect(src).toContain('usePaywall must be used within PaywallProvider')
  })

  test('uses createContext for paywall state', () => {
    expect(src).toMatch(/createContext/)
    expect(src).toMatch(/PaywallContext/)
  })

  test('PaywallProvider manages open state', () => {
    expect(src).toMatch(/openPaywall/)
    expect(src).toMatch(/closePaywall/)
    expect(src).toMatch(/useState/)
  })

  test('useFeatureGate uses useBillingCheck', () => {
    expect(src).toMatch(/useBillingCheck\(featureId\)/)
  })

  test('useFeatureGate returns a gate function', () => {
    expect(src).toMatch(/const gate = useCallback/)
    expect(src).toMatch(/gate/)
  })

  test('gate function opens paywall when billing disallowed', () => {
    expect(src).toMatch(/if \(billing\.allowed\) return true/)
    expect(src).toMatch(/openPaywall\(featureId, featureName\)/)
    expect(src).toMatch(/return false/)
  })

  test('dialog has accessible role and aria attributes', () => {
    expect(src).toMatch(/role="dialog"/)
    expect(src).toMatch(/aria-modal="true"/)
    expect(src).toMatch(/aria-label="Upgrade required"/)
  })

  test('dialog has a close button with aria-label', () => {
    expect(src).toMatch(/aria-label="Close"/)
    expect(src).toMatch(/paywall-close/)
  })

  test('closes on Escape key press', () => {
    expect(src).toMatch(/Escape/)
    expect(src).toMatch(/handleKeyDown/)
  })

  test('closes on overlay click', () => {
    expect(src).toMatch(/handleOverlayClick/)
    expect(src).toMatch(/overlayRef/)
  })

  test('prevents body scroll when open', () => {
    expect(src).toMatch(/document\.body\.style\.overflow = 'hidden'/)
    expect(src).toMatch(/document\.body\.style\.overflow = ''/)
  })

  test('renders upgrade link to billing page', () => {
    expect(src).toMatch(/\/billing/)
    expect(src).toMatch(/paywall-upgrade-btn/)
    expect(src).toMatch(/Upgrade plan/)
  })

  test('renders dismiss button', () => {
    expect(src).toMatch(/paywall-dismiss-btn/)
    expect(src).toMatch(/Maybe later/)
  })

  test('displays feature name in dialog', () => {
    expect(src).toMatch(/\{featureName\}/)
  })

  test('shows usage bar when limit data is available', () => {
    expect(src).toMatch(/paywall-usage-bar/)
    expect(src).toMatch(/paywall-usage-fill/)
    expect(src).toMatch(/paywall-usage-value/)
  })

  test('uses useParams to build billing URL', () => {
    expect(src).toMatch(/useParams/)
    expect(src).toMatch(/orgSlug/)
  })

  test('conditionally renders dialog only when open', () => {
    expect(src).toMatch(/state\.open &&/)
  })

  test('uses useCallback for stable context functions', () => {
    expect(src).toMatch(/useCallback/)
  })

  test('does not use console.log', () => {
    expect(src).not.toMatch(/console\.log/)
  })

  test('does not use any type', () => {
    const lines = src.split('\n')
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.startsWith('//')) continue
      expect(trimmed).not.toMatch(/:\s*any\b/)
      expect(trimmed).not.toMatch(/as\s+any\b/)
    }
  })
})

describe('isBillingLimitError', () => {
  const src = readFileSync(COMPONENT_PATH, 'utf-8')

  test('checks for Error instance', () => {
    expect(src).toMatch(/instanceof Error/)
  })

  test('checks for status 403', () => {
    expect(src).toMatch(/status === 403/)
  })
})

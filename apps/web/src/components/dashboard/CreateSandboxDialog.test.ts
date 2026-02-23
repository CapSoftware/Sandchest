import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const COMPONENT_PATH = join(import.meta.dir, 'CreateSandboxDialog.tsx')

describe('CreateSandboxDialog component', () => {
  const src = readFileSync(COMPONENT_PATH, 'utf-8')

  test('is a client component', () => {
    expect(src).toMatch(/^['"]use client['"]/)
  })

  test('uses useCreateSandbox hook for mutation', () => {
    expect(src).toContain('useCreateSandbox')
    expect(src).toContain("from '@/hooks/use-sandboxes'")
  })

  test('accepts open and onClose props', () => {
    expect(src).toMatch(/open:\s*boolean/)
    expect(src).toMatch(/onClose:\s*\(\)\s*=>/)
  })

  test('returns null when not open', () => {
    expect(src).toMatch(/if\s*\(\s*!open\s*\)\s*return\s*null/)
  })

  test('renders profile select with small/medium/large options', () => {
    expect(src).toContain("'small'")
    expect(src).toContain("'medium'")
    expect(src).toContain("'large'")
    expect(src).toMatch(/dash-select/)
  })

  test('renders image input field', () => {
    expect(src).toMatch(/id="csb-image"/)
    expect(src).toMatch(/type="text"/)
  })

  test('renders TTL input field', () => {
    expect(src).toMatch(/id="csb-ttl"/)
    expect(src).toMatch(/type="number"/)
  })

  test('supports environment variable key-value pairs', () => {
    expect(src).toMatch(/envEntries/)
    expect(src).toMatch(/ADD_ENV/)
    expect(src).toMatch(/REMOVE_ENV/)
    expect(src).toMatch(/UPDATE_ENV/)
  })

  test('calls createSandbox.mutate on form submit', () => {
    expect(src).toMatch(/createSandbox\.mutate\(/)
  })

  test('handles form submit with preventDefault', () => {
    expect(src).toMatch(/e\.preventDefault\(\)/)
  })

  test('disables inputs while mutation is pending', () => {
    expect(src).toMatch(/disabled=\{createSandbox\.isPending\}/)
  })

  test('shows success state with sandbox ID after creation', () => {
    expect(src).toMatch(/createdId/)
    expect(src).toMatch(/Sandbox created/)
  })

  test('provides copy button for created sandbox ID', () => {
    expect(src).toContain('CopyButton')
    expect(src).toMatch(/text=\{state\.createdId\}/)
  })

  test('handles 403 billing errors by opening paywall', () => {
    expect(src).toMatch(/err\.status\s*===\s*403/)
    expect(src).toMatch(/openPaywall/)
  })

  test('handles Escape key to dismiss', () => {
    expect(src).toMatch(/Escape/)
    expect(src).toMatch(/handleKeyDown/)
  })

  test('handles click outside to dismiss', () => {
    expect(src).toMatch(/handleOverlayClick/)
    expect(src).toMatch(/overlayRef/)
  })

  test('has proper accessibility attributes', () => {
    expect(src).toMatch(/role="dialog"/)
    expect(src).toMatch(/aria-modal="true"/)
    expect(src).toMatch(/aria-label/)
  })

  test('locks body scroll when open', () => {
    expect(src).toMatch(/document\.body\.style\.overflow\s*=\s*['"]hidden['"]/)
    expect(src).toMatch(/document\.body\.style\.overflow\s*=\s*['"]["']/)
  })

  test('resets form state on dismiss', () => {
    expect(src).toMatch(/dispatch\(\{\s*type:\s*['"]RESET['"]/)
  })

  test('does not use console.log', () => {
    expect(src).not.toMatch(/console\.log/)
  })

  test('builds CreateSandboxRequest from form state', () => {
    expect(src).toContain('CreateSandboxRequest')
    expect(src).toMatch(/profile/)
    expect(src).toMatch(/image/)
    expect(src).toMatch(/ttl_seconds/)
  })

  test('provides a replay URL link on success', () => {
    expect(src).toMatch(/createdReplayUrl/)
    expect(src).toMatch(/Open replay/)
  })
})

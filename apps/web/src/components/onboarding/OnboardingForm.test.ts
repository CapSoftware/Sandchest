import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const COMPONENT_PATH = join(import.meta.dir, 'OnboardingForm.tsx')

describe('OnboardingForm component', () => {
  const src = readFileSync(COMPONENT_PATH, 'utf-8')

  test('is a client component', () => {
    expect(src).toMatch(/^['"]use client['"]/)
  })

  test('imports useSession hook', () => {
    expect(src).toMatch(/import.*useSession.*from ['"]@\/hooks\/use-session['"]/)
  })

  test('imports useOrgs hook', () => {
    expect(src).toMatch(/import.*useOrgs.*from ['"]@\/hooks\/use-orgs['"]/)
  })

  test('imports useUpdateUser hook', () => {
    expect(src).toMatch(/import.*useUpdateUser.*from ['"]@\/hooks\/use-update-user['"]/)
  })

  test('imports useCreateOrg hook', () => {
    expect(src).toMatch(/import.*useCreateOrg.*from ['"]@\/hooks\/use-create-org['"]/)
  })

  test('imports useCustomer from autumn-js', () => {
    expect(src).toMatch(/import.*useCustomer.*from ['"]autumn-js\/react['"]/)
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

describe('OnboardingForm step flow', () => {
  const src = readFileSync(COMPONENT_PATH, 'utf-8')

  test('defines three steps: name, org, plan', () => {
    expect(src).toMatch(/['"]name['"]/)
    expect(src).toMatch(/['"]org['"]/)
    expect(src).toMatch(/['"]plan['"]/)
  })

  test('has step indicator component', () => {
    expect(src).toMatch(/StepIndicator/)
    expect(src).toMatch(/onboarding-steps/)
  })

  test('redirects to org-slug dashboard if user already has orgs', () => {
    expect(src).toMatch(/router\.replace\(`\/dashboard\/\$\{activeOrg\.slug\}`\)/)
  })

  test('finishes by redirecting to org-slug dashboard', () => {
    expect(src).toMatch(/window\.location\.href\s*=\s*`\/dashboard\/\$\{createdSlug\}`/)
  })

  test('tracks created slug in state', () => {
    expect(src).toMatch(/useState\(''\)/)
    expect(src).toMatch(/setCreatedSlug/)
  })

  test('passes slug to PlanStep', () => {
    expect(src).toMatch(/slug={createdSlug}/)
  })
})

describe('NameStep', () => {
  const src = readFileSync(COMPONENT_PATH, 'utf-8')

  test('renders name input', () => {
    expect(src).toMatch(/onboarding-name/)
    expect(src).toMatch(/autoComplete="name"/)
  })

  test('validates minimum name length', () => {
    expect(src).toMatch(/trimmed\.length\s*>=\s*2/)
  })

  test('calls updateUser on submit', () => {
    expect(src).toMatch(/updateUser\.mutate/)
  })

  test('shows loading state during save', () => {
    expect(src).toMatch(/Saving\.\.\./)
  })
})

describe('OrgStep', () => {
  const src = readFileSync(COMPONENT_PATH, 'utf-8')

  test('renders org name input', () => {
    expect(src).toMatch(/onboarding-org/)
    expect(src).toMatch(/Workspace name/)
  })

  test('generates slug from org name', () => {
    expect(src).toMatch(/function slugify/)
  })

  test('shows slug preview', () => {
    expect(src).toMatch(/onboarding-slug/)
  })

  test('calls createOrg on submit', () => {
    expect(src).toMatch(/createOrg\.mutate/)
  })

  test('passes slug to onComplete callback', () => {
    expect(src).toMatch(/onComplete\(slug\)/)
  })

  test('shows loading state during creation', () => {
    expect(src).toMatch(/Creating\.\.\./)
  })
})

describe('PlanStep', () => {
  const src = readFileSync(COMPONENT_PATH, 'utf-8')

  test('renders plan cards', () => {
    expect(src).toMatch(/onboarding-plan-card/)
    expect(src).toMatch(/onboarding-plans/)
  })

  test('has free, pro, and team plans', () => {
    expect(src).toMatch(/['"]free['"]/)
    expect(src).toMatch(/['"]pro['"]/)
    expect(src).toMatch(/['"]team['"]/)
  })

  test('uses Autumn attach for paid plans', () => {
    expect(src).toMatch(/attach\(/)
  })

  test('skips attach for free plan', () => {
    expect(src).toMatch(/!plan\.productId/)
  })

  test('has skip option', () => {
    expect(src).toMatch(/Skip for now/)
    expect(src).toMatch(/onboarding-skip/)
  })

  test('highlights recommended plan', () => {
    expect(src).toMatch(/highlighted/)
  })

  test('accepts slug prop for successUrl', () => {
    expect(src).toMatch(/slug: string;/)
    expect(src).toMatch(/\/dashboard\/\$\{slug\}/)
  })
})

describe('slugify utility', () => {
  const src = readFileSync(COMPONENT_PATH, 'utf-8')

  test('converts to lowercase', () => {
    expect(src).toMatch(/toLowerCase\(\)/)
  })

  test('replaces non-alphanumeric with hyphens', () => {
    expect(src).toContain('[^a-z0-9]+')
  })

  test('trims leading and trailing hyphens', () => {
    expect(src).toMatch(/\(\^-\|-\$\)/)
  })
})

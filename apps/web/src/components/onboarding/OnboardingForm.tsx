'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useSession } from '@/hooks/use-session'
import { useOrgs } from '@/hooks/use-orgs'
import { useUpdateUser } from '@/hooks/use-update-user'
import { useCreateOrg } from '@/hooks/use-create-org'
import { useCustomer } from 'autumn-js/react'
import ErrorMessage from '@/components/ui/ErrorMessage'

type Step = 'name' | 'org' | 'plan'

const STEPS: Step[] = ['name', 'org', 'plan']

const STEP_LABELS: Record<Step, string> = {
  name: 'Profile',
  org: 'Workspace',
  plan: 'Plan',
}

interface Plan {
  id: string
  name: string
  price: string
  period: string
  features: string[]
  cta: string
  productId: string | null
  highlighted: boolean
}

const PLANS: Plan[] = [
  {
    id: 'free',
    name: 'Free',
    price: '$0',
    period: '/month',
    features: ['5 concurrent sandboxes', '15 min TTL', 'Community support'],
    cta: 'Get started',
    productId: null,
    highlighted: false,
  },
  {
    id: 'pro',
    name: 'Pro',
    price: '$49',
    period: '/month',
    features: [
      '50 concurrent sandboxes',
      '4 hour TTL',
      'Priority support',
      'Snapshot forking',
    ],
    cta: 'Start free trial',
    productId: 'pro',
    highlighted: true,
  },
  {
    id: 'team',
    name: 'Team',
    price: '$149',
    period: '/month',
    features: [
      'Unlimited sandboxes',
      '24 hour TTL',
      'Dedicated support',
      'SSO & audit logs',
    ],
    cta: 'Start free trial',
    productId: 'team',
    highlighted: false,
  },
]

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
}

function StepIndicator({ current }: { current: Step }) {
  const currentIndex = STEPS.indexOf(current)

  return (
    <div className="onboarding-steps">
      {STEPS.map((step, i) => (
        <div
          key={step}
          className={`onboarding-step${i <= currentIndex ? ' active' : ''}${i < currentIndex ? ' completed' : ''}`}
        >
          <span className="onboarding-step-dot" />
          <span className="onboarding-step-label">{STEP_LABELS[step]}</span>
        </div>
      ))}
    </div>
  )
}

function NameStep({
  defaultName,
  onComplete,
}: {
  defaultName: string
  onComplete: () => void
}) {
  const [name, setName] = useState(defaultName)
  const updateUser = useUpdateUser()

  const trimmed = name.trim()
  const valid = trimmed.length >= 2

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!valid) return

    updateUser.mutate(
      { name: trimmed },
      { onSuccess: onComplete },
    )
  }

  return (
    <div className="auth-form-wrapper">
      <div className="auth-form-header">
        <h1 className="auth-heading">What should we call you?</h1>
        <p className="auth-description">This is your display name across Sandchest.</p>
      </div>

      <form onSubmit={handleSubmit} className="auth-form">
        <label className="auth-label" htmlFor="onboarding-name">
          Your name
        </label>
        <input
          id="onboarding-name"
          type="text"
          className="auth-input"
          placeholder="Jane Smith"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={updateUser.isPending}
          autoFocus
          autoComplete="name"
        />

        {updateUser.error && (
          <ErrorMessage
            message={updateUser.error.message}
            className="auth-error"
            role="alert"
          />
        )}

        <button
          type="submit"
          className="auth-button"
          disabled={!valid || updateUser.isPending}
        >
          {updateUser.isPending ? 'Saving...' : 'Continue'}
        </button>
      </form>
    </div>
  )
}

function OrgStep({ onComplete }: { onComplete: () => void }) {
  const [orgName, setOrgName] = useState('')
  const createOrg = useCreateOrg()

  const trimmed = orgName.trim()
  const slug = slugify(trimmed)
  const valid = trimmed.length >= 2 && slug.length >= 2

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!valid) return

    createOrg.mutate(
      { name: trimmed, slug },
      { onSuccess: onComplete },
    )
  }

  return (
    <div className="auth-form-wrapper">
      <div className="auth-form-header">
        <h1 className="auth-heading">Create your workspace</h1>
        <p className="auth-description">
          Workspaces group your sandboxes, API keys, and team members.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="auth-form">
        <label className="auth-label" htmlFor="onboarding-org">
          Workspace name
        </label>
        <input
          id="onboarding-org"
          type="text"
          className="auth-input"
          placeholder="Acme Inc"
          value={orgName}
          onChange={(e) => setOrgName(e.target.value)}
          disabled={createOrg.isPending}
          autoFocus
        />

        {slug && (
          <p className="onboarding-slug">
            sandchest.com/<strong>{slug}</strong>
          </p>
        )}

        {createOrg.error && (
          <ErrorMessage
            message={createOrg.error.message}
            className="auth-error"
            role="alert"
          />
        )}

        <button
          type="submit"
          className="auth-button"
          disabled={!valid || createOrg.isPending}
        >
          {createOrg.isPending ? 'Creating...' : 'Create workspace'}
        </button>
      </form>
    </div>
  )
}

function PlanStep({ onComplete }: { onComplete: () => void }) {
  const { attach } = useCustomer()
  const [loading, setLoading] = useState<string | null>(null)
  const [error, setError] = useState('')

  async function handleSelect(plan: Plan) {
    if (!plan.productId) {
      onComplete()
      return
    }

    setLoading(plan.id)
    setError('')

    try {
      const result = await attach({
        productId: plan.productId,
        successUrl: `${window.location.origin}/dashboard`,
      })

      if (result.error) {
        setError(result.error.message)
        setLoading(null)
        return
      }

      // If no redirect happened (free attach), continue
      onComplete()
    } catch {
      setError('Something went wrong. Please try again.')
      setLoading(null)
    }
  }

  return (
    <div className="auth-form-wrapper onboarding-plan-wrapper">
      <div className="auth-form-header">
        <h1 className="auth-heading">Choose your plan</h1>
        <p className="auth-description">
          Start free and upgrade when you need more.
        </p>
      </div>

      {error && (
        <ErrorMessage message={error} className="auth-error" role="alert" />
      )}

      <div className="onboarding-plans">
        {PLANS.map((plan) => (
          <div
            key={plan.id}
            className={`onboarding-plan-card${plan.highlighted ? ' highlighted' : ''}`}
          >
            <div className="onboarding-plan-header">
              <span className="onboarding-plan-name">{plan.name}</span>
              <span className="onboarding-plan-price">
                {plan.price}
                <span className="onboarding-plan-period">{plan.period}</span>
              </span>
            </div>
            <ul className="onboarding-plan-features">
              {plan.features.map((feature) => (
                <li key={feature}>{feature}</li>
              ))}
            </ul>
            <button
              className={`onboarding-plan-cta${plan.highlighted ? ' highlighted' : ''}`}
              onClick={() => handleSelect(plan)}
              disabled={loading !== null}
            >
              {loading === plan.id ? 'Loading...' : plan.cta}
            </button>
          </div>
        ))}
      </div>

      <button
        type="button"
        className="auth-link-button onboarding-skip"
        onClick={onComplete}
        disabled={loading !== null}
      >
        Skip for now
      </button>
    </div>
  )
}

export default function OnboardingForm() {
  const router = useRouter()
  const { data: session, isPending: sessionLoading } = useSession()
  const { data: orgs, isPending: orgsLoading } = useOrgs()
  const [step, setStep] = useState<Step>('name')

  // Redirect to dashboard if user already has orgs
  const hasOrgs = orgs && orgs.length > 0
  if (hasOrgs && !sessionLoading && !orgsLoading) {
    router.replace('/dashboard')
    return null
  }

  if (sessionLoading || orgsLoading) {
    return null
  }

  const emailPrefix = session?.user.email?.split('@')[0] ?? ''

  function goToOrg() {
    setStep('org')
  }

  function goToPlan() {
    setStep('plan')
  }

  function finish() {
    window.location.href = '/dashboard'
  }

  return (
    <>
      <StepIndicator current={step} />
      {step === 'name' && (
        <NameStep
          defaultName={session?.user.name ?? emailPrefix}
          onComplete={goToOrg}
        />
      )}
      {step === 'org' && <OrgStep onComplete={goToPlan} />}
      {step === 'plan' && <PlanStep onComplete={finish} />}
    </>
  )
}

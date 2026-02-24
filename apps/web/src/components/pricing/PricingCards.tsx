import Link from 'next/link'
import { SANDCHEST_TIERS } from '@/data/pricing'

const free = SANDCHEST_TIERS.free
const max = SANDCHEST_TIERS.max

function fmtPerSec(n: number) {
  return '$' + n.toFixed(7)
}

function fmtPerHr(n: number) {
  return '$' + n.toFixed(3)
}

const TIERS = [
  {
    name: free.name,
    price: '$0',
    period: '/mo',
    credits: `$${free.monthlyCredits} of free compute included`,
    highlighted: false,
    cta: 'Get started',
    ctaHref: '/signup',
    rates: [
      { resource: 'vCPU', perSec: fmtPerSec(free.vcpuPerSec), perHr: fmtPerHr(free.vcpuPerHr) },
      { resource: 'GiB RAM', perSec: fmtPerSec(free.ramGiBPerSec), perHr: fmtPerHr(free.ramGiBPerHr) },
    ],
    features: [
      `${free.maxConcurrent} concurrent sandboxes`,
      `${free.maxSessionHours} hour max session`,
      'Session replay',
      'Sub-second forking',
    ],
  },
  {
    name: max.name,
    price: `$${max.monthlyBase}`,
    period: '/mo',
    credits: `$${max.monthlyCredits} of free compute included`,
    highlighted: true,
    cta: 'Start building',
    ctaHref: '/signup',
    rates: [
      { resource: 'vCPU', perSec: fmtPerSec(max.vcpuPerSec), perHr: fmtPerHr(max.vcpuPerHr) },
      { resource: 'GiB RAM', perSec: fmtPerSec(max.ramGiBPerSec), perHr: fmtPerHr(max.ramGiBPerHr) },
    ],
    features: [
      `${max.maxConcurrent} concurrent sandboxes`,
      `${max.maxSessionHours} hour max session`,
      'Custom VM sizes',
      'Session replay',
      'Sub-second forking',
    ],
  },
  {
    name: 'Enterprise',
    price: 'Custom',
    period: '',
    credits: 'Special pricing for your team',
    highlighted: false,
    cta: 'Contact sales',
    ctaHref: 'mailto:sales@sandchest.com',
    rates: [],
    features: [
      'Unlimited concurrent sandboxes',
      'Unlimited session length',
      'All VM profiles',
      'SSO & SAML',
      'On-prem deployment',
      'Dedicated support',
    ],
  },
] as const

export default function PricingCards() {
  return (
    <div className="section">
      <div className="pricing-cards">
        {TIERS.map((tier) => (
          <div
            key={tier.name}
            className={`pricing-card${tier.highlighted ? ' highlighted' : ''}`}
          >
            <div className="pricing-card-header">
              <span className="pricing-card-name">{tier.name}</span>
              <div>
                <span className="pricing-card-price">{tier.price}</span>
                <span className="pricing-card-period">{tier.period}</span>
              </div>
              <span className="pricing-card-credits">{tier.credits}</span>
            </div>
            {tier.rates.length > 0 && (
              <div className="pricing-card-rates">
                {tier.rates.map((r) => (
                  <div key={r.resource} className="pricing-card-rate-row">
                    <span className="pricing-card-rate-resource">{r.resource}</span>
                    <span className="pricing-card-rate-values">
                      <span className="pricing-card-rate-sec">{r.perSec}/sec</span>
                      <span className="pricing-card-rate-hr">{r.perHr}/hr</span>
                    </span>
                  </div>
                ))}
              </div>
            )}
            <ul className="pricing-card-features">
              {tier.features.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
            <Link
              href={tier.ctaHref}
              className={`pricing-card-cta${tier.highlighted ? ' highlighted' : ''} no-underline hover:no-underline`}
            >
              {tier.cta}
            </Link>
          </div>
        ))}
      </div>
    </div>
  )
}

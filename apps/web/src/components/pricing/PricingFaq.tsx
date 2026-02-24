'use client'

import { useState } from 'react'

const FAQS = [
  {
    question: 'How granular is billing?',
    answer:
      'All usage is billed per-second. If your sandbox runs for 90 seconds, you pay for exactly 90 seconds. No rounding up to the nearest minute or hour.',
  },
  {
    question: 'What happens when my credits run out?',
    answer:
      'Once your included monthly credits are used up, you continue at the same per-second rate for your plan tier. There are no surprise rate changes or service interruptions. Credits reset at the start of each billing cycle.',
  },
  {
    question: 'How is forking priced?',
    answer:
      'Forked sandboxes are billed at the same per-second rate as regular sandboxes. The fork operation itself is free and completes in under a second. You only pay for the time the forked sandbox is running.',
  },
  {
    question: 'What are the free tier limits?',
    answer:
      'The free tier includes $100 of free compute every month (recurring, not one-time), up to 5 concurrent sandboxes, 1-hour max session length, and small VM profiles. No credit card required to start.',
  },
  {
    question: 'Do you offer enterprise or custom pricing?',
    answer:
      'Yes. If you need higher concurrency limits, dedicated infrastructure, custom SLAs, or volume discounts, contact us at sales@sandchest.com and we\'ll put together a plan that fits your needs.',
  },
] as const

function FaqItem({ question, answer }: { question: string; answer: string }) {
  const [open, setOpen] = useState(false)

  return (
    <div className="pricing-faq-item">
      <button
        className="pricing-faq-trigger"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span>{question}</span>
        <span className={`pricing-faq-chevron${open ? ' open' : ''}`}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 4.5L6 7.5L9 4.5" />
          </svg>
        </span>
      </button>
      {open && (
        <div className="pricing-faq-answer">
          {answer}
        </div>
      )}
    </div>
  )
}

export default function PricingFaq() {
  return (
    <div className="section">
      <div className="section-header" style={{ textAlign: 'center' }}>
        <h3 className="section-title">Frequently asked questions</h3>
      </div>
      <div className="pricing-faq">
        {FAQS.map((faq) => (
          <FaqItem key={faq.question} question={faq.question} answer={faq.answer} />
        ))}
      </div>
    </div>
  )
}

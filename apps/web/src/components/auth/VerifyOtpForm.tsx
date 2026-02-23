'use client'

import { Suspense } from 'react'
import VerifyOtpFormInner from './VerifyOtpFormInner'

export default function VerifyOtpForm() {
  return (
    <Suspense>
      <VerifyOtpFormInner />
    </Suspense>
  )
}

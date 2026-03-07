import { NextResponse } from 'next/server'
import {
  runSandboxSmokeTest,
  type SmokeProfile,
} from '../../../../../../packages/admin-cli/src/sandbox-smoke.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const DEFAULT_BASE_URL = 'https://api.sandchest.com'

function getSmokeConfig() {
  const apiKey =
    process.env['SANDCHEST_SMOKE_API_KEY']?.trim() ||
    process.env['SANDCHEST_API_KEY']?.trim()

  if (!apiKey) {
    throw new Error(
      'Missing SANDCHEST_SMOKE_API_KEY or SANDCHEST_API_KEY for admin smoke runs.',
    )
  }

  const ttlValue = process.env['SANDCHEST_SMOKE_TTL_SECONDS']
  const ttlSeconds = ttlValue ? Number.parseInt(ttlValue, 10) : undefined

  return {
    apiKey,
    baseUrl:
      process.env['SANDCHEST_SMOKE_BASE_URL']?.trim() ||
      process.env['SANDCHEST_BASE_URL']?.trim() ||
      DEFAULT_BASE_URL,
    image: process.env['SANDCHEST_SMOKE_IMAGE']?.trim() || undefined,
    profile: (process.env['SANDCHEST_SMOKE_PROFILE']?.trim() || undefined) as
      | SmokeProfile
      | undefined,
    ttlSeconds,
  }
}

export async function POST() {
  try {
    const result = await runSandboxSmokeTest(getSmokeConfig())
    return NextResponse.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

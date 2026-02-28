import { NextResponse } from 'next/server'

export async function GET() {
  const apiToken = process.env.ADMIN_API_TOKEN
  const apiUrl = process.env.API_URL ?? 'https://api.sandchest.com'

  try {
    const res = await fetch(`${apiUrl}/v1/admin/status`, {
      headers: {
        ...(apiToken ? { Authorization: `Bearer ${apiToken}` } : {}),
      },
      // Don't cache — always fetch fresh
      cache: 'no-store',
    })

    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: 'Unknown error' })) as { error?: string }
      return NextResponse.json(
        { api: { status: 'error' }, error: data.error ?? `HTTP ${res.status}` },
        { status: 200 },
      )
    }

    const data = await res.json()
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({
      api: { status: 'unreachable', uptime_seconds: 0, version: 'unknown', draining: false },
      redis: { status: 'unknown' },
      workers: [],
      nodes: [],
    })
  }
}

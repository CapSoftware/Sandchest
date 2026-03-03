import { NextResponse } from 'next/server'
import { createClient } from '@/lib/simulate-sdk'

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      apiKey: string
      baseUrl: string
      sandboxId: string
    }

    const client = createClient(body.apiKey, body.baseUrl)
    const sandbox = await client.get(body.sandboxId)
    await sandbox.stop()

    return NextResponse.json({ ok: true, status: sandbox.status })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

import { NextResponse } from 'next/server'
import type { ProfileName } from '@sandchest/contract'
import { createClient } from '@/lib/simulate-sdk'

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      apiKey: string
      baseUrl: string
      image?: string | undefined
      profile?: string | undefined
      ttlSeconds?: number | undefined
    }

    const client = createClient(body.apiKey, body.baseUrl)
    const sandbox = await client.create({
      image: body.image || undefined,
      profile: (body.profile as ProfileName) || undefined,
      ttlSeconds: body.ttlSeconds || undefined,
    })

    return NextResponse.json({
      id: sandbox.id,
      status: sandbox.status,
      replayUrl: sandbox.replayUrl,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function DELETE(request: Request) {
  try {
    const body = (await request.json()) as {
      apiKey: string
      baseUrl: string
      sandboxId: string
    }

    const client = createClient(body.apiKey, body.baseUrl)
    const sandbox = await client.get(body.sandboxId)
    await sandbox.destroy()

    return NextResponse.json({ ok: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

import { NextResponse } from 'next/server'
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

    const baseUrl = body.baseUrl.replace(/\/$/, '')
    const apiBody: Record<string, unknown> = {
      profile: body.profile || 'small',
      ttl_seconds: body.ttlSeconds || 3600,
    }
    if (body.image) {
      apiBody.image = body.image
    }

    const res = await fetch(`${baseUrl}/v1/sandboxes`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${body.apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(apiBody),
    })

    const text = await res.text()
    let data: Record<string, unknown>
    try {
      data = JSON.parse(text) as Record<string, unknown>
    } catch {
      return NextResponse.json(
        { error: `API returned ${res.status}: ${text.slice(0, 500)}` },
        { status: res.status || 500 },
      )
    }

    if (!res.ok) {
      const msg = (data.message as string) || (data.error as string) || `API ${res.status}`
      return NextResponse.json({ error: msg }, { status: res.status })
    }

    return NextResponse.json({
      id: data.sandbox_id,
      status: data.status,
      replayUrl: data.replay_url,
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

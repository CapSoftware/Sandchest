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
    const url = `${baseUrl}/v1/sandboxes`
    const apiBody: Record<string, unknown> = {
      profile: body.profile || 'small',
      ttl_seconds: body.ttlSeconds || 3600,
    }
    if (body.image) {
      apiBody.image = body.image
    }

    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${body.apiKey}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify(apiBody),
      })
    } catch (fetchErr) {
      const detail = fetchErr instanceof Error ? fetchErr.message : 'Unknown fetch error'
      return NextResponse.json(
        { error: `Failed to connect to ${url}: ${detail}` },
        { status: 502 },
      )
    }

    const text = await res.text()
    let data: Record<string, unknown>
    try {
      data = JSON.parse(text) as Record<string, unknown>
    } catch {
      const preview = text.length > 0 ? text.slice(0, 500) : '(empty body)'
      return NextResponse.json(
        { error: `API returned ${res.status} with non-JSON response: ${preview}` },
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

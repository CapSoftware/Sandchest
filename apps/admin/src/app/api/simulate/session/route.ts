import { NextResponse } from 'next/server'
import { createClient } from '@/lib/simulate-sdk'
import { Session } from '@sandchest/sdk'

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      apiKey: string
      baseUrl: string
      sandboxId: string
      shell?: string | undefined
    }

    const client = createClient(body.apiKey, body.baseUrl)
    const sandbox = await client.get(body.sandboxId)
    const session = await sandbox.session.create({
      shell: body.shell || undefined,
    })

    return NextResponse.json({
      sessionId: session.id,
      sandboxId: body.sandboxId,
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
      sessionId: string
    }

    const client = createClient(body.apiKey, body.baseUrl)
    const sandbox = await client.get(body.sandboxId)
    // Construct Session directly since SDK doesn't have getSession()
    const session = new Session(body.sessionId, body.sandboxId, sandbox._http)
    await session.destroy()

    return NextResponse.json({ ok: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

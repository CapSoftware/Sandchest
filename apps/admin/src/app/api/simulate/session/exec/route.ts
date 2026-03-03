import { NextResponse } from 'next/server'
import { createClient } from '@/lib/simulate-sdk'
import { Session } from '@sandchest/sdk'

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      apiKey: string
      baseUrl: string
      sandboxId: string
      sessionId: string
      command: string
    }

    const client = createClient(body.apiKey, body.baseUrl)
    const sandbox = await client.get(body.sandboxId)
    const session = new Session(body.sessionId, body.sandboxId, sandbox._http)
    const result = await session.exec(body.command)

    return NextResponse.json({
      execId: result.execId,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: result.durationMs,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/simulate-sdk'

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      apiKey: string
      baseUrl: string
      sandboxId: string
      command: string
      cwd?: string | undefined
    }

    const client = createClient(body.apiKey, body.baseUrl)
    const sandbox = await client.get(body.sandboxId)
    const result = await sandbox.exec(body.command, {
      cwd: body.cwd || undefined,
    })

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

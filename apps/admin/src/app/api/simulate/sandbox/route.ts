import { NextResponse } from 'next/server'
import type { ProfileName } from '@sandchest/contract'
import { createClient } from '@/lib/simulate-sdk'

function sdkErrorStatus(err: unknown): number {
  if (typeof err === 'object' && err !== null && 'status' in err) {
    const s = (err as { status: number }).status
    if (s >= 400 && s < 600) return s
  }
  return 500
}

function sdkErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return 'Unknown error'
}

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
      waitReady: false,
    })

    return NextResponse.json({
      id: sandbox.id,
      status: sandbox.status,
      replayUrl: sandbox.replayUrl,
    })
  } catch (err) {
    return NextResponse.json(
      { error: sdkErrorMessage(err) },
      { status: sdkErrorStatus(err) },
    )
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
    return NextResponse.json(
      { error: sdkErrorMessage(err) },
      { status: sdkErrorStatus(err) },
    )
  }
}

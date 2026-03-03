import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { createClient } from '@/lib/simulate-sdk'

export async function GET(request: NextRequest) {
  try {
    const apiKey = request.headers.get('x-simulate-api-key')
    const baseUrl = request.headers.get('x-simulate-base-url')
    const sandboxId = request.nextUrl.searchParams.get('sandboxId')
    const path = request.nextUrl.searchParams.get('path') ?? '/'

    if (!apiKey || !baseUrl || !sandboxId) {
      return NextResponse.json({ error: 'Missing required parameters' }, { status: 400 })
    }

    const client = createClient(apiKey, baseUrl)
    const sandbox = await client.get(sandboxId)
    const files = await sandbox.fs.ls(path)

    return NextResponse.json({ files })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    const formData = await request.formData()
    const apiKey = formData.get('apiKey') as string
    const baseUrl = formData.get('baseUrl') as string
    const sandboxId = formData.get('sandboxId') as string
    const path = formData.get('path') as string
    const file = formData.get('file') as File

    if (!apiKey || !baseUrl || !sandboxId || !path || !file) {
      return NextResponse.json({ error: 'Missing required parameters' }, { status: 400 })
    }

    const client = createClient(apiKey, baseUrl)
    const sandbox = await client.get(sandboxId)
    const content = new Uint8Array(await file.arrayBuffer())
    await sandbox.fs.upload(path, content)

    return NextResponse.json({ ok: true })
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
      path: string
    }

    const client = createClient(body.apiKey, body.baseUrl)
    const sandbox = await client.get(body.sandboxId)
    await sandbox.fs.rm(body.path)

    return NextResponse.json({ ok: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

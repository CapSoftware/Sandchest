import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { createClient } from '@/lib/simulate-sdk'

export async function GET(request: NextRequest) {
  try {
    const apiKey = request.headers.get('x-simulate-api-key')
    const baseUrl = request.headers.get('x-simulate-base-url')
    const sandboxId = request.nextUrl.searchParams.get('sandboxId')
    const path = request.nextUrl.searchParams.get('path')

    if (!apiKey || !baseUrl || !sandboxId || !path) {
      return NextResponse.json({ error: 'Missing required parameters' }, { status: 400 })
    }

    const client = createClient(apiKey, baseUrl)
    const sandbox = await client.get(sandboxId)
    const content = await sandbox.fs.download(path)

    const filename = path.split('/').pop() ?? 'download'
    return new NextResponse(content.buffer as ArrayBuffer, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

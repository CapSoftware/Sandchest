import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { adminServers } from '@sandchest/db/schema'
import { bytesToId, NODE_PREFIX } from '@sandchest/contract'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ serverId: string }> },
) {
  const { serverId } = await params
  const db = getDb()
  const serverIdBuf = Buffer.from(serverId, 'hex') as unknown as Uint8Array

  const [server] = await db
    .select()
    .from(adminServers)
    .where(eq(adminServers.id, serverIdBuf))
    .limit(1)

  if (!server) {
    return NextResponse.json({ error: 'Server not found' }, { status: 404 })
  }

  if (!server.nodeId) {
    return NextResponse.json({ sandboxes: [], count: 0 })
  }

  const encodedNodeId = bytesToId(NODE_PREFIX, new Uint8Array(server.nodeId))
  const apiToken = process.env.ADMIN_API_TOKEN
  const apiUrl = process.env.API_URL ?? 'https://api.sandchest.com'
  const url = `${apiUrl}/v1/admin/nodes/${encodedNodeId}/sandboxes`

  try {
    const res = await fetch(url, {
      headers: {
        ...(apiToken ? { Authorization: `Bearer ${apiToken}` } : {}),
      },
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.error(`[sandboxes] API ${res.status} for ${encodedNodeId}: ${body.substring(0, 200)}`)
      return NextResponse.json({ sandboxes: [], count: 0 })
    }

    const data = await res.json() as { sandboxes: unknown[]; count: number }
    return NextResponse.json(data)
  } catch (err) {
    console.error(`[sandboxes] fetch error:`, err)
    return NextResponse.json({ sandboxes: [], count: 0 })
  }
}

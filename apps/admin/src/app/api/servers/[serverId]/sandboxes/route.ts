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

  try {
    const res = await fetch(`${apiUrl}/v1/admin/nodes/${encodedNodeId}/sandboxes`, {
      headers: {
        ...(apiToken ? { Authorization: `Bearer ${apiToken}` } : {}),
      },
    })

    if (!res.ok) {
      return NextResponse.json({ sandboxes: [], count: 0 })
    }

    const data = await res.json() as { sandboxes: unknown[]; count: number }
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ sandboxes: [], count: 0 })
  }
}

import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { adminServers } from '@sandchest/db/schema'
import { bytesToId, NODE_PREFIX } from '@sandchest/contract'

export async function POST(
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
    return NextResponse.json({ error: 'No node ID — deploy the daemon first' }, { status: 400 })
  }

  const nodeId = bytesToId(NODE_PREFIX, server.nodeId as unknown as Uint8Array)
  const apiUrl = process.env.API_URL ?? 'https://api.sandchest.com'
  const apiToken = process.env.ADMIN_API_TOKEN

  const res = await fetch(`${apiUrl}/v1/admin/nodes`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiToken ? { Authorization: `Bearer ${apiToken}` } : {}),
    },
    body: JSON.stringify({
      id: nodeId,
      name: server.name ?? server.ip,
      hostname: server.ip,
    }),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return NextResponse.json(
      { error: `API registration failed (${res.status}): ${text}` },
      { status: 502 },
    )
  }

  const data = await res.json() as Record<string, unknown>
  return NextResponse.json({
    success: true,
    node_id: nodeId,
    hostname: server.ip,
    upserted: data.upserted ?? false,
  })
}

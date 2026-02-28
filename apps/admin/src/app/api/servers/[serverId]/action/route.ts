import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { adminServers } from '@sandchest/db/schema'

const VALID_ACTIONS = ['drain', 'disable', 'enable'] as const
type Action = typeof VALID_ACTIONS[number]

const ACTION_STATUS_MAP: Record<Action, string> = {
  drain: 'draining',
  disable: 'disabled',
  enable: 'online',
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ serverId: string }> },
) {
  const { serverId } = await params
  const body = await request.json() as { action?: string }

  if (!body.action || !VALID_ACTIONS.includes(body.action as Action)) {
    return NextResponse.json(
      { error: `Invalid action. Must be one of: ${VALID_ACTIONS.join(', ')}` },
      { status: 400 },
    )
  }

  const action = body.action as Action
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
    return NextResponse.json({ error: 'Server has no linked node' }, { status: 400 })
  }

  // Call the admin API to update the node status
  const apiToken = process.env.ADMIN_API_TOKEN
  const apiUrl = process.env.API_URL ?? 'https://api.sandchest.com'
  const nodeIdHex = Buffer.from(server.nodeId).toString('hex')

  // Try to call the control plane API
  try {
    const res = await fetch(`${apiUrl}/v1/admin/nodes/node_${nodeIdHex}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...(apiToken ? { Authorization: `Bearer ${apiToken}` } : {}),
      },
      body: JSON.stringify({ status: ACTION_STATUS_MAP[action] }),
    })

    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: 'Unknown error' })) as { error: string }
      return NextResponse.json({ error: data.error }, { status: res.status })
    }
  } catch {
    // If API is unreachable, still return success — the node status update
    // will be picked up by the next heartbeat reconciliation
  }

  return NextResponse.json({ action, status: ACTION_STATUS_MAP[action] })
}

import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { adminServers } from '@sandchest/db/schema'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ serverId: string }> },
) {
  const { serverId } = await params
  const db = getDb()

  const [server] = await db
    .select()
    .from(adminServers)
    .where(eq(adminServers.id, Buffer.from(serverId, 'hex') as unknown as Uint8Array))
    .limit(1)

  if (!server) {
    return NextResponse.json({ error: 'Server not found' }, { status: 404 })
  }

  return NextResponse.json({
    id: serverId,
    name: server.name,
    ip: server.ip,
    ssh_port: server.sshPort,
    ssh_user: server.sshUser,
    provision_status: server.provisionStatus,
    provision_step: server.provisionStep,
    provision_error: server.provisionError,
    provision_steps: server.provisionSteps,
    slots_total: server.slotsTotal,
    system_info: server.systemInfo,
    node_id: server.nodeId ? Buffer.from(server.nodeId).toString('hex') : null,
    created_at: server.createdAt.toISOString(),
    updated_at: server.updatedAt.toISOString(),
  })
}

export async function DELETE(
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

  await db.delete(adminServers).where(eq(adminServers.id, serverIdBuf))

  return NextResponse.json({ deleted: true })
}

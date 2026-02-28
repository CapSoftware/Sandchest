import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { adminServers } from '@sandchest/db/schema'
import { encrypt } from '@/lib/encryption'
import { createPasswordSshConnection, generateAndInstallKey } from '@/lib/ssh'

export async function GET() {
  const db = getDb()
  const rows = await db.select().from(adminServers)

  const servers = rows.map((row) => ({
    id: Buffer.from(row.id).toString('hex'),
    name: row.name,
    ip: row.ip,
    provision_status: row.provisionStatus,
    node_id: row.nodeId ? Buffer.from(row.nodeId).toString('hex') : null,
    slots_total: row.slotsTotal,
    system_info: row.systemInfo,
    created_at: row.createdAt.toISOString(),
  }))

  return NextResponse.json({ servers })
}

export async function POST(request: Request) {
  const body = await request.json() as {
    name?: string
    ip?: string
    ssh_port?: number
    ssh_user?: string
    ssh_key?: string
    ssh_password?: string
    slots_total?: number
  }

  if (!body.name || !body.ip) {
    return NextResponse.json(
      { error: 'name and ip are required' },
      { status: 400 },
    )
  }

  if (!body.ssh_key && !body.ssh_password) {
    return NextResponse.json(
      { error: 'Either ssh_key or ssh_password is required' },
      { status: 400 },
    )
  }

  let sshKey: string

  if (body.ssh_password) {
    // Connect via password, generate + install an SSH key, then use that
    let conn: Awaited<ReturnType<typeof createPasswordSshConnection>>
    try {
      conn = await createPasswordSshConnection({
        host: body.ip,
        port: body.ssh_port ?? 22,
        username: body.ssh_user ?? 'root',
        password: body.ssh_password,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Connection failed'
      return NextResponse.json(
        { error: `SSH connection failed: ${msg}` },
        { status: 422 },
      )
    }
    try {
      sshKey = await generateAndInstallKey(conn)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Key installation failed'
      return NextResponse.json(
        { error: `Key setup failed: ${msg}` },
        { status: 422 },
      )
    } finally {
      conn.end()
    }
  } else {
    sshKey = body.ssh_key!
  }

  const { ciphertext, iv, tag } = encrypt(sshKey)

  const db = getDb()

  // Generate a UUIDv7-like ID as binary
  const id = crypto.randomUUID().replace(/-/g, '')
  const idBuf = Buffer.from(id, 'hex') as unknown as Uint8Array

  await db.insert(adminServers).values({
    id: idBuf,
    name: body.name,
    ip: body.ip,
    sshPort: body.ssh_port ?? 22,
    sshUser: body.ssh_user ?? 'root',
    sshKeyEncrypted: ciphertext,
    sshKeyIv: iv,
    sshKeyTag: tag,
    slotsTotal: body.slots_total ?? 4,
    provisionStatus: 'pending',
  })

  return NextResponse.json({ id, name: body.name }, { status: 201 })
}

import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { adminServers } from '@sandchest/db/schema'
import {
  getServerNumber,
  activateRescue,
  deactivateRescue,
  hardwareReset,
  waitForSsh,
  runInstallimage,
  waitForFreshOs,
} from '@/lib/hetzner'
import { createPasswordSshConnection, generateAndInstallKey } from '@/lib/ssh'
import { encrypt } from '@/lib/encryption'

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

  try {
    // 1. Find Hetzner server number by IP
    const serverNumber = await getServerNumber(server.ip)

    // 2. Activate rescue mode
    const rescuePassword = await activateRescue(serverNumber)

    // 3. Hardware reset to boot into rescue
    await hardwareReset(server.ip)

    // 4. Wait for rescue system to come up
    await waitForSsh(server.ip, rescuePassword, { label: 'Rescue system' })

    // 5. Run installimage to install Ubuntu 24.04
    const output = await runInstallimage(server.ip, rescuePassword)

    // 6. Deactivate rescue so next boot goes to installed OS
    await deactivateRescue(serverNumber)

    // 7. Hardware reset to boot into fresh OS
    await hardwareReset(server.ip)

    // 8. Wait for fresh OS to boot and verify it's Ubuntu
    await waitForFreshOs(server.ip, rescuePassword)

    // 9. Re-install SSH key (installimage wipes authorized_keys)
    const conn = await createPasswordSshConnection({
      host: server.ip,
      port: server.sshPort,
      username: server.sshUser,
      password: rescuePassword,
    })
    let sshKeyEncrypted: string
    let sshKeyIv: string
    let sshKeyTag: string
    try {
      const sshKey = await generateAndInstallKey(conn)
      const encrypted = encrypt(sshKey)
      sshKeyEncrypted = encrypted.ciphertext
      sshKeyIv = encrypted.iv
      sshKeyTag = encrypted.tag
    } finally {
      conn.end()
    }

    // 10. Reset DB state for fresh provisioning (with new SSH key)
    await db
      .update(adminServers)
      .set({
        provisionStatus: 'pending',
        nodeId: null,
        provisionStep: null,
        provisionError: null,
        provisionSteps: null,
        systemInfo: null,
        sshKeyEncrypted,
        sshKeyIv,
        sshKeyTag,
        updatedAt: new Date(),
      })
      .where(eq(adminServers.id, serverIdBuf))

    return NextResponse.json({ success: true, output })
  } catch (err) {
    return NextResponse.json(
      { error: `Reinstall failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    )
  }
}

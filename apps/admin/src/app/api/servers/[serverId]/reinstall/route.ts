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

  // Validate Hetzner credentials synchronously — fail fast if they're wrong
  let serverNumber: number
  let rescuePassword: string
  try {
    console.log('[reinstall] Looking up Hetzner server number for IP:', server.ip)
    serverNumber = await getServerNumber(server.ip)
    console.log('[reinstall] Server number:', serverNumber)

    console.log('[reinstall] Activating rescue mode...')
    rescuePassword = await activateRescue(serverNumber)
    console.log('[reinstall] Rescue activated, triggering hardware reset...')

    await hardwareReset(server.ip)
    console.log('[reinstall] Hardware reset triggered')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[reinstall] Hetzner API failed:', msg)
    return NextResponse.json({ error: `Hetzner API failed: ${msg}` }, { status: 500 })
  }

  // Mark as reinstalling
  await db
    .update(adminServers)
    .set({
      provisionStatus: 'provisioning',
      provisionStep: 'reinstall-os',
      provisionError: null,
      updatedAt: new Date(),
    })
    .where(eq(adminServers.id, serverIdBuf))

  // Run the long part in the background (rescue SSH → install → reboot → key setup)
  runReinstall(serverId, server.ip, server.sshPort, server.sshUser, serverNumber, rescuePassword).catch((err) => {
    console.error('[reinstall] Background process crashed:', err)
  })

  return NextResponse.json({ success: true, status: 'reinstalling' })
}

async function runReinstall(
  serverId: string,
  ip: string,
  sshPort: number,
  sshUser: string,
  serverNumber: number,
  rescuePassword: string,
) {
  const db = getDb()
  const serverIdBuf = Buffer.from(serverId, 'hex') as unknown as Uint8Array

  try {
    // 1. Wait for rescue system to come up
    console.log('[reinstall] Waiting for rescue SSH...')
    await waitForSsh(ip, rescuePassword, { label: 'Rescue system' })
    console.log('[reinstall] Rescue SSH ready')

    // 2. Run installimage to install Ubuntu 24.04
    console.log('[reinstall] Running installimage...')
    await runInstallimage(ip, rescuePassword)
    console.log('[reinstall] installimage complete')

    // 3. Deactivate rescue so next boot goes to installed OS
    console.log('[reinstall] Deactivating rescue...')
    await deactivateRescue(serverNumber)

    // 4. Hardware reset to boot into fresh OS
    console.log('[reinstall] Triggering second hardware reset...')
    await hardwareReset(ip)

    // 5. Wait for fresh OS to boot and verify it's Ubuntu
    console.log('[reinstall] Waiting for fresh OS...')
    await waitForFreshOs(ip, rescuePassword)
    console.log('[reinstall] Fresh OS is up')

    // 6. Re-install SSH key (installimage wipes authorized_keys)
    console.log('[reinstall] Installing new SSH key...')
    const conn = await createPasswordSshConnection({
      host: ip,
      port: sshPort,
      username: sshUser,
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
    console.log('[reinstall] SSH key installed')

    // 7. Reset DB state for fresh provisioning (with new SSH key)
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

    console.log('[reinstall] Done! Server reset to pending.')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[reinstall] Failed:', msg)
    await db
      .update(adminServers)
      .set({
        provisionStatus: 'failed',
        provisionError: `Reinstall failed: ${msg}`,
        updatedAt: new Date(),
      })
      .where(eq(adminServers.id, serverIdBuf))
  }
}

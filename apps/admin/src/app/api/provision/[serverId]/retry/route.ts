import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { adminServers } from '@sandchest/db/schema'
import { decrypt } from '@/lib/encryption'
import { createSshConnection, execCommand } from '@/lib/ssh'
import { PROVISION_STEPS, resolveCommands, type StepResult, type ProvisionContext } from '@/lib/provisioner'
import { generateId, idToBytes, NODE_PREFIX } from '@sandchest/contract'
import { setFlySecrets } from '@/lib/fly'

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

  if (server.provisionStatus !== 'failed') {
    return NextResponse.json({ error: 'Can only retry from failed state' }, { status: 409 })
  }

  // Find the failed step index (PlanetScale may return JSON columns as strings)
  const raw = server.provisionSteps
  const steps: StepResult[] = Array.isArray(raw)
    ? raw as StepResult[]
    : typeof raw === 'string'
      ? JSON.parse(raw) as StepResult[]
      : []
  const failedIndex = steps.findIndex((s) => s.status === 'failed')
  if (failedIndex === -1) {
    return NextResponse.json({ error: 'No failed step found' }, { status: 400 })
  }

  // Decrypt SSH key
  let sshKey: string
  try {
    sshKey = decrypt(server.sshKeyEncrypted, server.sshKeyIv, server.sshKeyTag)
  } catch {
    return NextResponse.json({ error: 'Failed to decrypt SSH key' }, { status: 500 })
  }

  // Reset failed and subsequent steps to pending
  for (let i = failedIndex; i < steps.length; i++) {
    steps[i] = { id: steps[i]!.id, status: 'pending' }
  }

  await db
    .update(adminServers)
    .set({
      provisionStatus: 'provisioning',
      provisionStep: PROVISION_STEPS[failedIndex]!.id,
      provisionSteps: steps,
      provisionError: null,
      updatedAt: new Date(),
    })
    .where(eq(adminServers.id, serverIdBuf))

  const nodeId = generateId(NODE_PREFIX)
  const ctx: ProvisionContext = { nodeId, ip: server.ip }

  // Run remaining steps in background
  retryProvisioning(serverId, server.ip, server.sshPort, server.sshUser, sshKey, steps, failedIndex, ctx).catch(
    () => {},
  )

  return NextResponse.json({ status: 'provisioning', retry_from: PROVISION_STEPS[failedIndex]!.id })
}

async function retryProvisioning(
  serverId: string,
  ip: string,
  port: number,
  username: string,
  privateKey: string,
  stepResults: StepResult[],
  startIndex: number,
  ctx: ProvisionContext,
) {
  const db = getDb()
  const serverIdBuf = Buffer.from(serverId, 'hex') as unknown as Uint8Array

  let conn
  try {
    conn = await createSshConnection({ host: ip, port, username, privateKey })
  } catch (err) {
    await db
      .update(adminServers)
      .set({
        provisionStatus: 'failed',
        provisionError: `SSH connection failed: ${err instanceof Error ? err.message : String(err)}`,
        updatedAt: new Date(),
      })
      .where(eq(adminServers.id, serverIdBuf))
    return
  }

  // Collect system info if missing
  try {
    const cpuResult = await execCommand(conn, 'lscpu | grep "Model name" | head -1 | cut -d: -f2 | xargs')
    const ramResult = await execCommand(conn, 'free -h | awk \'/Mem:/ {print $2}\'')
    const diskResult = await execCommand(conn, 'df -h / | awk \'NR==2 {print $2}\'')
    const osResult = await execCommand(conn, 'cat /etc/os-release | grep PRETTY_NAME | cut -d= -f2 | tr -d \'"\'')

    await db
      .update(adminServers)
      .set({
        systemInfo: {
          cpu: cpuResult.stdout.trim() || undefined,
          ram: ramResult.stdout.trim() || undefined,
          disk: diskResult.stdout.trim() || undefined,
          os: osResult.stdout.trim() || undefined,
        },
        updatedAt: new Date(),
      })
      .where(eq(adminServers.id, serverIdBuf))
  } catch {
    // Non-fatal
  }

  for (let i = startIndex; i < PROVISION_STEPS.length; i++) {
    const step = PROVISION_STEPS[i]!

    stepResults[i] = { id: step.id, status: 'running' }
    await db
      .update(adminServers)
      .set({
        provisionStep: step.id,
        provisionSteps: [...stepResults],
        updatedAt: new Date(),
      })
      .where(eq(adminServers.id, serverIdBuf))

    const commands = await resolveCommands(step, ctx)
    const fullCommand = commands.join(' && ')

    try {
      const result = await execCommand(conn, fullCommand, step.timeoutMs)
      const output = result.stdout + (result.stderr ? `\n${result.stderr}` : '')

      if (result.code !== 0) {
        stepResults[i] = { id: step.id, status: 'failed', output: output.trim() }
        await db
          .update(adminServers)
          .set({
            provisionStatus: 'failed',
            provisionStep: step.id,
            provisionSteps: [...stepResults],
            provisionError: `Step "${step.name}" failed with exit code ${result.code}`,
            updatedAt: new Date(),
          })
          .where(eq(adminServers.id, serverIdBuf))
        conn.end()
        return
      }

      let fullOutput = output
      if (step.validate) {
        const valResult = await execCommand(conn, step.validate)
        if (valResult.code !== 0) {
          stepResults[i] = { id: step.id, status: 'failed', output: `${output}\n---\nValidation failed: ${valResult.stderr || valResult.stdout}`.trim() }
          await db
            .update(adminServers)
            .set({
              provisionStatus: 'failed',
              provisionStep: step.id,
              provisionSteps: [...stepResults],
              provisionError: `Validation for "${step.name}" failed`,
              updatedAt: new Date(),
            })
            .where(eq(adminServers.id, serverIdBuf))
          conn.end()
          return
        }
        fullOutput += `\nValidation: ${valResult.stdout.trim()}`
      }

      stepResults[i] = { id: step.id, status: 'completed', output: fullOutput.trim() }
    } catch (err) {
      stepResults[i] = { id: step.id, status: 'failed', output: `Error: ${err instanceof Error ? err.message : String(err)}` }
      await db
        .update(adminServers)
        .set({
          provisionStatus: 'failed',
          provisionStep: step.id,
          provisionSteps: [...stepResults],
          provisionError: `Step "${step.name}" threw: ${err instanceof Error ? err.message : String(err)}`,
          updatedAt: new Date(),
        })
        .where(eq(adminServers.id, serverIdBuf))
      conn.end()
      return
    }

    await db
      .update(adminServers)
      .set({
        provisionSteps: [...stepResults],
        updatedAt: new Date(),
      })
      .where(eq(adminServers.id, serverIdBuf))
  }

  // Link the API to the node via Fly.io secrets
  const flyToken = process.env.FLY_ACCESS_TOKEN
  const flyApp = process.env.FLY_APP_NAME || 'sandchest-api'

  if (flyToken) {
    try {
      const [caResult, certResult, keyResult] = await Promise.all([
        execCommand(conn, 'cat /etc/sandchest/certs/ca.pem'),
        execCommand(conn, 'cat /etc/sandchest/certs/client.pem'),
        execCommand(conn, 'cat /etc/sandchest/certs/client.key'),
      ])

      if (caResult.code !== 0 || certResult.code !== 0 || keyResult.code !== 0) {
        throw new Error('Failed to read mTLS client certificates from server')
      }

      await setFlySecrets(flyApp, {
        NODE_GRPC_ADDR: `${ip}:50051`,
        NODE_GRPC_NODE_ID: ctx.nodeId,
        MTLS_CA_PEM: caResult.stdout.trim(),
        MTLS_CLIENT_CERT_PEM: certResult.stdout.trim(),
        MTLS_CLIENT_KEY_PEM: keyResult.stdout.trim(),
      }, flyToken)
    } catch (err) {
      conn.end()
      await db
        .update(adminServers)
        .set({
          provisionStatus: 'failed',
          provisionError: `Provisioning succeeded but API linking failed: ${err instanceof Error ? err.message : String(err)}`,
          provisionSteps: [...stepResults],
          updatedAt: new Date(),
        })
        .where(eq(adminServers.id, serverIdBuf))
      return
    }
  }

  conn.end()
  const nodeIdBytes = idToBytes(ctx.nodeId) as unknown as Uint8Array
  await db
    .update(adminServers)
    .set({
      provisionStatus: 'completed',
      provisionSteps: [...stepResults],
      nodeId: nodeIdBytes,
      updatedAt: new Date(),
    })
    .where(eq(adminServers.id, serverIdBuf))
}

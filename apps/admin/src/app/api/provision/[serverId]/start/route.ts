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

  const [server] = await db
    .select()
    .from(adminServers)
    .where(eq(adminServers.id, Buffer.from(serverId, 'hex') as unknown as Uint8Array))
    .limit(1)

  if (!server) {
    return NextResponse.json({ error: 'Server not found' }, { status: 404 })
  }

  // Allow re-provisioning from any state (handles stuck "provisioning" states)

  // Decrypt SSH key
  let sshKey: string
  try {
    sshKey = decrypt(server.sshKeyEncrypted, server.sshKeyIv, server.sshKeyTag)
  } catch {
    return NextResponse.json({ error: 'Failed to decrypt SSH key' }, { status: 500 })
  }

  // Initialize step results
  const stepResults: StepResult[] = PROVISION_STEPS.map((step) => ({
    id: step.id,
    status: 'pending' as const,
  }))

  // Update server status to provisioning
  await db
    .update(adminServers)
    .set({
      provisionStatus: 'provisioning',
      provisionStep: PROVISION_STEPS[0]!.id,
      provisionSteps: stepResults,
      provisionError: null,
      updatedAt: new Date(),
    })
    .where(eq(adminServers.id, Buffer.from(serverId, 'hex') as unknown as Uint8Array))

  // Generate node ID upfront so the deploy step can write it to node.env
  const nodeId = generateId(NODE_PREFIX)

  // Run provisioning in background (fire and forget)
  runProvisioning(serverId, server.ip, server.sshPort, server.sshUser, sshKey, stepResults, { nodeId, ip: server.ip }).catch(
    () => {},
  )

  return NextResponse.json({ status: 'provisioning', steps: stepResults })
}

async function runProvisioning(
  serverId: string,
  ip: string,
  port: number,
  username: string,
  privateKey: string,
  stepResults: StepResult[],
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

  // Collect system info
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
    // Non-fatal: continue provisioning even if system info fails
  }

  for (let i = 0; i < PROVISION_STEPS.length; i++) {
    const step = PROVISION_STEPS[i]!

    // Mark step as running
    stepResults[i] = { id: step.id, status: 'running' }
    await db
      .update(adminServers)
      .set({
        provisionStep: step.id,
        provisionSteps: [...stepResults],
        updatedAt: new Date(),
      })
      .where(eq(adminServers.id, serverIdBuf))

    // Execute all commands for this step
    const commands = await resolveCommands(step, ctx)
    const fullCommand = commands.join(' && ')

    try {
      const result = await execCommand(conn, fullCommand, step.timeoutMs)
      let output = result.stdout + (result.stderr ? `\n${result.stderr}` : '')

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

      // Run validation if present
      if (step.validate) {
        const valResult = await execCommand(conn, step.validate)
        if (valResult.code !== 0) {
          stepResults[i] = {
            id: step.id,
            status: 'failed',
            output: `${output}\n---\nValidation failed: ${valResult.stderr || valResult.stdout}`.trim(),
          }
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
        output += `\nValidation: ${valResult.stdout.trim()}`
      }

      stepResults[i] = { id: step.id, status: 'completed', output: output.trim() }
    } catch (err) {
      stepResults[i] = {
        id: step.id,
        status: 'failed',
        output: `Error: ${err instanceof Error ? err.message : String(err)}`,
      }
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

    // Update progress
    await db
      .update(adminServers)
      .set({
        provisionSteps: [...stepResults],
        updatedAt: new Date(),
      })
      .where(eq(adminServers.id, serverIdBuf))
  }

  // All steps completed — link the API to the node via Fly.io secrets
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

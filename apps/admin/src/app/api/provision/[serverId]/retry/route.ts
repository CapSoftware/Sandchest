import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { adminServers } from '@sandchest/db/schema'
import { decrypt } from '@/lib/encryption'
import { createSshConnection, execCommand } from '@/lib/ssh'
import { PROVISION_STEPS, resolveCommands, type StepResult } from '@/lib/provisioner'

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

  // Run remaining steps in background
  retryProvisioning(serverId, server.ip, server.sshPort, server.sshUser, sshKey, steps, failedIndex).catch(
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

    const fullCommand = resolveCommands(step).join(' && ')

    try {
      const result = await execCommand(conn, fullCommand)
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
          stepResults[i] = { id: step.id, status: 'failed', output: `Validation failed: ${valResult.stderr || valResult.stdout}`.trim() }
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

  conn.end()
  await db
    .update(adminServers)
    .set({
      provisionStatus: 'completed',
      provisionSteps: [...stepResults],
      updatedAt: new Date(),
    })
    .where(eq(adminServers.id, serverIdBuf))
}

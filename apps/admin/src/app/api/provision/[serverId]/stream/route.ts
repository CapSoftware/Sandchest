import { eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { adminServers } from '@sandchest/db/schema'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ serverId: string }> },
) {
  const { serverId } = await params
  const db = getDb()
  const serverIdBuf = Buffer.from(serverId, 'hex') as unknown as Uint8Array

  const encoder = new TextEncoder()
  let closed = false

  const stream = new ReadableStream({
    async start(controller) {
      const poll = async () => {
        if (closed) return

        try {
          const [server] = await db
            .select({
              provisionStatus: adminServers.provisionStatus,
              provisionStep: adminServers.provisionStep,
              provisionSteps: adminServers.provisionSteps,
              provisionError: adminServers.provisionError,
            })
            .from(adminServers)
            .where(eq(adminServers.id, serverIdBuf))
            .limit(1)

          if (!server) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: 'not_found' })}\n\n`))
            controller.close()
            return
          }

          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                status: server.provisionStatus,
                current_step: server.provisionStep,
                steps: server.provisionSteps,
                error: server.provisionError,
              })}\n\n`,
            ),
          )

          if (server.provisionStatus === 'completed' || server.provisionStatus === 'failed') {
            controller.close()
            closed = true
            return
          }

          setTimeout(poll, 2000)
        } catch {
          if (!closed) {
            controller.close()
            closed = true
          }
        }
      }

      await poll()
    },
    cancel() {
      closed = true
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  })
}

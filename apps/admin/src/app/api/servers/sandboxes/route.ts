import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { adminServers } from '@sandchest/db/schema'
import { bytesToId, NODE_PREFIX } from '@sandchest/contract'

export async function GET() {
  const db = getDb()
  const rows = await db
    .select()
    .from(adminServers)
    .where(eq(adminServers.provisionStatus, 'completed'))

  const apiToken = process.env.ADMIN_API_TOKEN
  const apiUrl = process.env.API_URL ?? 'https://api.sandchest.com'

  const entries = await Promise.all(
    rows
      .filter((row) => row.nodeId !== null)
      .map(async (row) => {
        const serverId = Buffer.from(row.id).toString('hex')
        const encodedNodeId = bytesToId(NODE_PREFIX, new Uint8Array(row.nodeId!))

        try {
          const res = await fetch(`${apiUrl}/v1/admin/nodes/${encodedNodeId}/sandboxes`, {
            headers: {
              ...(apiToken ? { Authorization: `Bearer ${apiToken}` } : {}),
            },
          })

          if (!res.ok) return [serverId, 0] as const

          const data = await res.json() as { count: number }
          return [serverId, data.count] as const
        } catch {
          return [serverId, 0] as const
        }
      }),
  )

  const counts: Record<string, number> = Object.fromEntries(entries)

  return NextResponse.json({ counts })
}

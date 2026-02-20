import { sql } from 'drizzle-orm'
import { nodes } from './schema/nodes'
import { images } from './schema/images'
import { profiles } from './schema/profiles'
import type { Database } from './client'

/**
 * Idempotent seed function. Safe to run multiple times — uses onDuplicateKeyUpdate
 * to upsert rows that already exist.
 */
export async function seed(db: Database) {
  // Seed profiles: small, medium, large
  await db
    .insert(profiles)
    .values([
      {
        id: new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
        name: 'small',
        cpuCores: 2,
        memoryMb: 4096,
        diskGb: 40,
        description: '2 vCPU, 4 GB RAM, 40 GB disk',
      },
      {
        id: new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]),
        name: 'medium',
        cpuCores: 4,
        memoryMb: 8192,
        diskGb: 80,
        description: '4 vCPU, 8 GB RAM, 80 GB disk',
      },
      {
        id: new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3]),
        name: 'large',
        cpuCores: 8,
        memoryMb: 16384,
        diskGb: 160,
        description: '8 vCPU, 16 GB RAM, 160 GB disk',
      },
    ])
    .onDuplicateKeyUpdate({ set: { description: sql`VALUES(description)` } })

  // Seed initial image: ubuntu-22.04/base
  await db
    .insert(images)
    .values({
      id: new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0]),
      osVersion: 'ubuntu-22.04',
      toolchain: 'base',
      kernelRef: 'images/ubuntu-22.04-base/vmlinux',
      rootfsRef: 'images/ubuntu-22.04-base/rootfs.ext4',
      digest: '0000000000000000000000000000000000000000000000000000000000000000',
      sizeBytes: 0,
    })
    .onDuplicateKeyUpdate({ set: { toolchain: sql`VALUES(toolchain)` } })

  // Seed dev node
  await db
    .insert(nodes)
    .values({
      id: new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0]),
      name: 'dev-node-01',
      hostname: 'localhost',
      slotsTotal: 10,
      status: 'offline',
    })
    .onDuplicateKeyUpdate({ set: { hostname: sql`VALUES(hostname)` } })
}

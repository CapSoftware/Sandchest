import { sql } from 'drizzle-orm'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { nodes } from './schema/nodes.js'
import { images } from './schema/images.js'
import { profiles } from './schema/profiles.js'
import type { Database } from './client.js'

/** Well-known profile IDs (stable BINARY(16) values for deterministic seeding). */
export const PROFILE_IDS = {
  small: new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
  medium: new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]),
  large: new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3]),
} as const

/** Well-known image IDs. */
export const IMAGE_IDS = {
  'ubuntu-22.04/base': new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0]),
} as const

/** Well-known dev node ID (not used in production). */
export const DEV_NODE_ID = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0])

/**
 * Seed mandatory reference data for a fresh production database.
 *
 * Populates:
 * - VM profiles (small, medium, large)
 * - Base OS images (ubuntu-22.04/base)
 *
 * Idempotent — safe to run multiple times (upserts via onDuplicateKeyUpdate).
 */
export async function seed(db: Database) {
  await seedProfiles(db)
  await seedImages(db)
}

/**
 * Seed production reference data plus dev-only data (dev node).
 * Use this for local development environments.
 */
export async function seedDev(db: Database) {
  await seed(db)
  await seedDevNode(db)
}

async function seedProfiles(db: Database) {
  await db
    .insert(profiles)
    .values([
      {
        id: PROFILE_IDS.small,
        name: 'small',
        cpuCores: 2,
        memoryMb: 4096,
        diskGb: 40,
        description: '2 vCPU, 4 GB RAM, 40 GB disk',
      },
      {
        id: PROFILE_IDS.medium,
        name: 'medium',
        cpuCores: 4,
        memoryMb: 8192,
        diskGb: 80,
        description: '4 vCPU, 8 GB RAM, 80 GB disk',
      },
      {
        id: PROFILE_IDS.large,
        name: 'large',
        cpuCores: 8,
        memoryMb: 16384,
        diskGb: 160,
        description: '8 vCPU, 16 GB RAM, 160 GB disk',
      },
    ])
    .onDuplicateKeyUpdate({ set: { description: sql`VALUES(description)` } })
}

async function seedImages(db: Database) {
  await db
    .insert(images)
    .values({
      id: IMAGE_IDS['ubuntu-22.04/base'],
      osVersion: 'ubuntu-22.04',
      toolchain: 'base',
      kernelRef: 'images/ubuntu-22.04-base/vmlinux',
      rootfsRef: 'images/ubuntu-22.04-base/rootfs.ext4',
      digest: '0000000000000000000000000000000000000000000000000000000000000000',
      sizeBytes: 0,
    })
    .onDuplicateKeyUpdate({ set: { toolchain: sql`VALUES(toolchain)` } })
}

async function seedDevNode(db: Database) {
  await db
    .insert(nodes)
    .values({
      id: DEV_NODE_ID,
      name: 'dev-node-01',
      hostname: 'localhost',
      slotsTotal: 10,
      status: 'offline',
    })
    .onDuplicateKeyUpdate({ set: { hostname: sql`VALUES(hostname)` } })
}

// ---------------------------------------------------------------------------
// Standalone runner: bun run packages/db/src/seed.ts [--dev]
// ---------------------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url)
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('/seed.ts')) {
  const { config } = await import('dotenv')
  config({ path: resolve(dirname(__filename), '..', '..', '..', '.env') })

  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error('DATABASE_URL environment variable is required')
    process.exit(1)
  }

  const { createDatabase } = await import('./client.js')
  const db = createDatabase(databaseUrl)
  const isDev = process.argv.includes('--dev')

  try {
    if (isDev) {
      await seedDev(db)
      console.log('Seed complete (production + dev data)')
    } else {
      await seed(db)
      console.log('Seed complete (production reference data)')
    }
    console.log('  - 3 profiles (small, medium, large)')
    console.log('  - 1 image (ubuntu-22.04/base)')
    if (isDev) console.log('  - 1 dev node (dev-node-01)')
    process.exit(0)
  } catch (err: unknown) {
    console.error('Seed failed:', err)
    process.exit(1)
  }
}

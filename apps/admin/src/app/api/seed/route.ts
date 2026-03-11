import { NextResponse } from 'next/server'
import { createDatabase } from '@sandchest/db'
import { seed } from '@sandchest/db/seed'

export async function POST() {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    return NextResponse.json({ error: 'DATABASE_URL not configured' }, { status: 500 })
  }

  try {
    const db = createDatabase(databaseUrl, { connectionLimit: 1 })
    await seed(db)
    return NextResponse.json({
      success: true,
      message: 'Seeded 3 profiles + 5 images (ubuntu-22.04: base, node-22, bun, python-3.12, go-1.22)',
    })
  } catch (err) {
    return NextResponse.json(
      { error: `Seed failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    )
  }
}

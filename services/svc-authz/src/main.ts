import 'reflect-metadata'
import { join } from 'node:path'
import { runner } from 'node-pg-migrate'
import { Pool } from 'pg'
import { NestFactory } from '@nestjs/core'
import { withTransaction } from '@gadong/kernel'
import { AppModule } from './app.module'
import { seedRoleTemplates } from './seed/roles'

/**
 * Runs every pending `migrations/*.js` against `DATABASE_URL` before the
 * app starts serving (matching `svc-config`'s `main.ts`, Task 7).
 * `createSchema: true` creates the `authz` schema itself if it doesn't
 * exist yet. Not exercised against a real Postgres in this environment —
 * there is none here (Task 8 brief, carried-forward binding).
 */
async function runMigrations(databaseUrl: string): Promise<void> {
  await runner({
    databaseUrl,
    dir: join(__dirname, '..', 'migrations'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
    schema: 'authz',
    createSchema: true,
  })
}

/**
 * Seeds the permission catalog and all ten role templates on every boot
 * (Task 8 brief §5) — idempotent, so a restart is a no-op against an
 * already-seeded database (`seed/roles.test.ts` proves this by content
 * hash). Runs in its own transaction via kernel's `withTransaction`, not
 * as part of `runMigrations` — schema DDL and data seeding are kept
 * separate so a future migration tool run never needs this seed logic
 * in scope.
 */
async function runSeed(databaseUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl, options: '-c search_path=authz' })
  try {
    await withTransaction(pool, (tx) => seedRoleTemplates(tx))
  } finally {
    await pool.end()
  }
}

/** Port 3000 on `0.0.0.0` matches every other service's container contract (deploy/docker-compose.yml's `http-health` healthcheck). */
async function bootstrap(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL']
  if (!databaseUrl) throw new Error('svc-authz: DATABASE_URL is required')
  await runMigrations(databaseUrl)
  await runSeed(databaseUrl)
  const app = await NestFactory.create(AppModule)
  await app.listen(3000, '0.0.0.0')
}

bootstrap().catch((err: unknown) => {
  console.error('svc-authz failed to start:', err)
  process.exit(1)
})

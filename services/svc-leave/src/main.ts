import 'reflect-metadata'
import { join } from 'node:path'
import { runner } from 'node-pg-migrate'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'

/**
 * Runs every pending `migrations/*.js` against `DATABASE_URL` before the
 * app starts serving — the same pattern `services/svc-config/src/main.ts`
 * established (Task 7 brief §6) and `services/svc-attendance/src/main.ts`
 * carried forward. `createSchema: true` creates the `leave` schema itself
 * if it doesn't exist yet, so a first boot against a fresh database needs
 * nothing pre-provisioned beyond the role/database. Re-running this on
 * every restart is safe: node-pg-migrate tracks applied migrations in its
 * own `pgmigrations` ledger table and only ever executes a given migration
 * file once. Not exercised against a real Postgres in this environment —
 * there is none here (Task 14 brief CONSTRAINTS) — a later integration
 * task covers real-Postgres behaviour, matching Task 13b for `svc-config`.
 */
async function runMigrations(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL']
  if (!databaseUrl) throw new Error('svc-leave: DATABASE_URL is required to run migrations')
  await runner({
    databaseUrl,
    dir: join(__dirname, '..', 'migrations'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
    schema: 'leave',
    createSchema: true,
  })
}

/** Port 3000 on `0.0.0.0` matches every other service's container contract (deploy/docker-compose.yml's `http-health` healthcheck). */
async function bootstrap(): Promise<void> {
  await runMigrations()
  const app = await NestFactory.create(AppModule)
  await app.listen(3000, '0.0.0.0')
}

bootstrap().catch((err: unknown) => {
  console.error('svc-leave failed to start:', err)
  process.exit(1)
})

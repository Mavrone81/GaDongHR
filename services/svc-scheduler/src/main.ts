import 'reflect-metadata'
import { join } from 'node:path'
import { runner } from 'node-pg-migrate'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'

/**
 * Runs every pending `migrations/*.js` against `DATABASE_URL` before the
 * app starts serving, matching `services/svc-config/src/main.ts`.
 * `createSchema: true` creates the `scheduler` schema itself if it doesn't
 * exist yet, so a first boot against a fresh database needs nothing
 * pre-provisioned beyond the role/database. `migrationsTable: 'pgmigrations'`
 * is node-pg-migrate's own applied-migrations ledger — it is what makes
 * re-running this function on every restart idempotent: a migration file
 * already recorded there is never re-executed, so `1754400000000_scheduler-
 * schema.js`'s `up()` runs at most once per database regardless of how many
 * times this process (re)starts.
 *
 * Not exercised against a real Postgres in this environment — there is none
 * here (Task 14 brief CONSTRAINTS) — a later integration task covers
 * real-Postgres verification, matching Task 7's deferral.
 */
async function runMigrations(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL']
  if (!databaseUrl) throw new Error('svc-scheduler: DATABASE_URL is required to run migrations')
  await runner({
    databaseUrl,
    dir: join(__dirname, '..', 'migrations'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
    schema: 'scheduler',
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
  console.error('svc-scheduler failed to start:', err)
  process.exit(1)
})

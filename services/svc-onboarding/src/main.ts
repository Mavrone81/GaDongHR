import 'reflect-metadata'
import { join } from 'node:path'
import { runner } from 'node-pg-migrate'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'

/**
 * Runs every pending `migrations/*.js` against `DATABASE_URL` before the
 * app starts serving, matching `svc-config`'s `main.ts` exactly.
 * `createSchema: true` creates the `onboarding` schema itself if it
 * doesn't exist yet, so a first boot against a fresh database needs
 * nothing pre-provisioned beyond the role/database. `migrationsTable:
 * 'pgmigrations'` is what makes re-running this on every container start
 * idempotent: node-pg-migrate records each applied migration's name in
 * that table and only executes what is not yet recorded, so a second boot
 * against an already-migrated database applies nothing and errors on
 * nothing — it does not re-run `1756000000000_onboarding-schema.js`'s
 * `up()` a second time.
 *
 * Not exercised against a real Postgres in this environment — there is
 * none here (Task 14 brief CONSTRAINTS) — a later integration task covers
 * real-Postgres verification, the same deferral `svc-config`'s `main.ts`
 * documents.
 */
async function runMigrations(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL']
  if (!databaseUrl) throw new Error('svc-onboarding: DATABASE_URL is required to run migrations')
  await runner({
    databaseUrl,
    dir: join(__dirname, '..', 'migrations'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
    schema: 'onboarding',
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
  console.error('svc-onboarding failed to start:', err)
  process.exit(1)
})

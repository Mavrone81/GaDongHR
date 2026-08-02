import 'reflect-metadata'
import { join } from 'node:path'
import { runner } from 'node-pg-migrate'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'

/**
 * Runs every pending `migrations/*.js` against `DATABASE_URL` before the
 * app starts serving — identical shape to `services/svc-config`'s
 * `runMigrations` (Task 14 brief: "src/main.ts runs migrations then listens
 * on 3000, matching svc-config"). `createSchema: true` creates the
 * `timesheet` schema itself if it doesn't exist yet, so a first boot
 * against a fresh database needs nothing pre-provisioned beyond the
 * role/database. Not exercised against a real Postgres in this environment
 * — there is none here (Task 14 brief CONSTRAINTS).
 */
async function runMigrations(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL']
  if (!databaseUrl) throw new Error('svc-timesheet: DATABASE_URL is required to run migrations')
  await runner({
    databaseUrl,
    dir: join(__dirname, '..', 'migrations'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
    schema: 'timesheet',
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
  console.error('svc-timesheet failed to start:', err)
  process.exit(1)
})

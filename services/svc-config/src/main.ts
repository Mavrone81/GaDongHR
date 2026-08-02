import 'reflect-metadata'
import { join } from 'node:path'
import { runner } from 'node-pg-migrate'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'

/**
 * Runs every pending `migrations/*.js` against `DATABASE_URL` before the
 * app starts serving (Task 7 brief §6). `createSchema: true` creates the
 * `config` schema itself if it doesn't exist yet, so a first boot against a
 * fresh database needs nothing pre-provisioned beyond the role/database.
 * Not exercised against a real Postgres in this environment — there is
 * none here (Task 7 brief) — Task 13b covers real-Postgres integration.
 */
async function runMigrations(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL']
  if (!databaseUrl) throw new Error('svc-config: DATABASE_URL is required to run migrations')
  await runner({
    databaseUrl,
    dir: join(__dirname, '..', 'migrations'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
    schema: 'config',
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
  console.error('svc-config failed to start:', err)
  process.exit(1)
})

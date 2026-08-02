import 'reflect-metadata'
import { join } from 'node:path'
import { runner } from 'node-pg-migrate'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'

/**
 * Runs every pending `migrations/*.js` against `DATABASE_URL` before the app
 * starts serving, matching `services/svc-config`'s `main.ts`. `createSchema:
 * true` creates the `audit` schema itself if it doesn't exist yet.
 *
 * This connection must be a privileged/owner role, never the `audit` role
 * the migration itself creates and locks down to SELECT/INSERT only — the
 * migration issues `CREATE SCHEMA`/`CREATE TABLE`/`GRANT`, none of which the
 * `audit` role could do to itself. Provisioning which role `DATABASE_URL`
 * authenticates as for the migration step vs. the app's runtime queries is
 * an infra/deploy-bootstrap concern outside this service's `src`/
 * `migrations` (see task-9-report.md).
 *
 * Not exercised against a real Postgres in this environment — there is none
 * here (Task 9 brief CONSTRAINTS).
 */
async function runMigrations(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL']
  if (!databaseUrl) throw new Error('svc-audit: DATABASE_URL is required to run migrations')
  await runner({
    databaseUrl,
    dir: join(__dirname, '..', 'migrations'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
    schema: 'audit',
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
  console.error('svc-audit failed to start:', err)
  process.exit(1)
})

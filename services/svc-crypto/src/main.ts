import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'

/**
 * svc-crypto owns no schema (Task 6 brief §5) — there are no migrations to
 * run before listening. Port 3000 on `0.0.0.0` matches every other
 * service's container contract (see `deploy/docker-compose.yml`'s
 * `http-health` healthcheck against `127.0.0.1:3000/health`).
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule)
  await app.listen(3000, '0.0.0.0')
}

bootstrap().catch((err: unknown) => {
  // Startup failure only — never logs a request/response body, a wrapped
  // DEK, or an AppRole secret (see `vault.client.ts`).
  console.error('svc-crypto failed to start:', err)
  process.exit(1)
})

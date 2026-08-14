import { Body, Controller, Get, HttpException, Post } from '@nestjs/common'
import { GadongError, Public, RequirePermission, buildHealth } from '@gadong/kernel'
import type { EncryptRequest, FieldClass, HealthPayload } from '@gadong/kernel'
import { CryptoService } from './crypto.service'

interface EncryptBody {
  fields: EncryptRequest[]
}
interface EncryptResponse {
  fields: Record<string, string>
}
interface DecryptBody {
  entityId: string
  field: string
  ciphertext: string
  purpose: string
}
interface DecryptResponse {
  value: string
}
interface BidxBody {
  fieldClass: FieldClass
  field: string
  value: string
}
interface BidxResponse {
  bidx: string
}

/**
 * The HTTP boundary for `POST /encrypt`, `/decrypt`, `/bidx` and
 * `GET /health` — the exact shapes `packages/kernel/src/crypto/client.ts`'s
 * already-merged `CryptoClient` sends and expects (Task 6 brief: "Read it
 * first and match it exactly — a mismatch is a runtime failure no test
 * here would catch").
 *
 * **crypto-auth task (defense-in-depth fix):** `svc-crypto` used to mount
 * no guard at all — reachable, unauthenticated, by any container on the
 * shared `gadong-internal` bridge network, not just its intended callers.
 * `AppModule` now mounts the kernel's `PermissionGuard` globally, and every
 * route below declares the least-privilege permission a calling service's
 * machine token must hold: `crypto.encrypt` for `/encrypt`, `crypto.decrypt`
 * for `/decrypt`, `crypto.bidx` for `/bidx` — three DISTINCT permissions,
 * not one coarse `crypto.access`, specifically so a service that only ever
 * encrypts (e.g. `svc-claims`, `svc-leave`) cannot also decrypt merely by
 * virtue of being a valid crypto caller. `GET /health` stays `@Public()` —
 * Docker's healthcheck, the deploy script and monitoring carry no bearer
 * token, matching every other service's health route. See
 * `deploy/scripts/seed.sh`'s per-service grants table for which service
 * holds which of the three, and why.
 */
@Controller()
export class CryptoController {
  constructor(private readonly cryptoService: CryptoService) {}

  @Post('encrypt')
  @RequirePermission('crypto.encrypt')
  async encrypt(@Body() body: EncryptBody): Promise<EncryptResponse> {
    const fields = await this.runFailClosed(() => this.cryptoService.encryptBatch(body.fields))
    return { fields }
  }

  @Post('decrypt')
  @RequirePermission('crypto.decrypt')
  async decrypt(@Body() body: DecryptBody): Promise<DecryptResponse> {
    const value = await this.runFailClosed(() =>
      this.cryptoService.decrypt(body.entityId, body.field, body.ciphertext, body.purpose),
    )
    return { value }
  }

  @Post('bidx')
  @RequirePermission('crypto.bidx')
  async bidx(@Body() body: BidxBody): Promise<BidxResponse> {
    const bidx = await this.runFailClosed(() => this.cryptoService.bidx(body.fieldClass, body.field, body.value))
    return { bidx }
  }

  @Get('health')
  @Public()
  async health(): Promise<HealthPayload> {
    const vault = await this.cryptoService.health()
    return buildHealth('svc-crypto', { vault })
  }

  /**
   * `CryptoService` throws `GadongError` (never a raw `Error`) for every
   * expected failure. Nest only knows how to turn its own `HttpException`
   * into the right status code and body, so this is the one place that
   * translates a `GadongError` into the `{code, message_i18n_key,
   * details}` envelope (`global-constraints.md`) at the declared
   * `httpStatus` — anything that is not a `GadongError` is a genuine bug
   * and is left to propagate (and surface as Nest's default 500), rather
   * than being silently reshaped into a crypto error it isn't.
   */
  private async runFailClosed<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (err) {
      if (err instanceof GadongError) throw new HttpException(err.toEnvelope(), err.httpStatus)
      throw err
    }
  }
}

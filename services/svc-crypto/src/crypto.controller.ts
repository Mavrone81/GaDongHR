import { Body, Controller, Get, HttpException, Post } from '@nestjs/common'
import { GadongError, buildHealth } from '@gadong/kernel'
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
 * **Deliberately no `@RequirePermission` on this controller or any of its
 * routes, and `AppModule` deliberately does not register the kernel's
 * `PermissionGuard`.** Every other service's routes are reached by an
 * authenticated end user and must declare a permission (deny-by-default);
 * `svc-crypto` is reached only by the other 14 services, service-to-service,
 * through `CryptoClient` — there is no end-user principal to check a
 * permission against here. This is the one service in the system where an
 * unannotated route is correct, not an oversight — see
 * `crypto.controller.test.ts`'s "deliberately declares no permissions"
 * suite, which is the guardrail against a future reader "fixing" this.
 */
@Controller()
export class CryptoController {
  constructor(private readonly cryptoService: CryptoService) {}

  @Post('encrypt')
  async encrypt(@Body() body: EncryptBody): Promise<EncryptResponse> {
    const fields = await this.runFailClosed(() => this.cryptoService.encryptBatch(body.fields))
    return { fields }
  }

  @Post('decrypt')
  async decrypt(@Body() body: DecryptBody): Promise<DecryptResponse> {
    const value = await this.runFailClosed(() =>
      this.cryptoService.decrypt(body.entityId, body.field, body.ciphertext, body.purpose),
    )
    return { value }
  }

  @Post('bidx')
  async bidx(@Body() body: BidxBody): Promise<BidxResponse> {
    const bidx = await this.runFailClosed(() => this.cryptoService.bidx(body.fieldClass, body.field, body.value))
    return { bidx }
  }

  @Get('health')
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

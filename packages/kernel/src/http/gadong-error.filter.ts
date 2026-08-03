import 'reflect-metadata'
import { Catch } from '@nestjs/common'
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common'
import { GadongError } from '../errors'

/**
 * The subset of Express's `Response` this filter needs — narrow on purpose
 * so the kernel never takes a hard dependency on `express`/`@types/express`
 * (it only has `@nestjs/common`, `reflect-metadata` and `rxjs` as peer
 * dependencies; see `packages/kernel/package.json`). `@nestjs/platform-express`
 * hands back a real Express response that structurally satisfies this at
 * every service that registers this filter.
 */
interface HttpResponseLike {
  status(code: number): { json(body: unknown): unknown }
}

/**
 * Task 16e, defect 2: every `GadongError` already carries the right
 * `httpStatus` and a `toEnvelope()` — `{code, message_i18n_key, details}` —
 * but nothing ever mapped that onto the actual HTTP response. Nest has no
 * built-in idea what a `GadongError` is (it is a plain `Error` subclass, not
 * a `HttpException`), so every one that reached Nest's default exception
 * handling unmapped — most visibly, every deny thrown directly by
 * `PermissionGuard` (`authz/guard.ts`'s `noPermissionDeclaredError()` and
 * `permissionDenied()`), since a guard's throw happens before any
 * controller's own local `try`/`catch` (the `runFailClosed`-style
 * per-controller translation several services already hand-roll) ever runs
 * — surfaced to the caller as an unhandled 500, turning a deliberate "you
 * may not" into a false "we are broken" that clients then retry.
 *
 * `@Catch(GadongError)` is what keeps this filter's blast radius exact:
 * Nest's `ExceptionsHandler` only ever invokes a filter for an exception
 * whose constructor (or ancestor) appears in its `@Catch(...)` list — see
 * `@nestjs/core`'s `exceptions-handler.js`/`exception-filter.js` — so any
 * exception that is not a `GadongError` (a genuine bug, a thrown string, an
 * unexpected `TypeError` from a real defect) is never routed to `catch()`
 * below at all; it falls straight through to Nest's own base handler and
 * keeps producing its current generic `{statusCode:500,message:"Internal
 * server error"}` body, exactly as before this filter existed. This filter
 * adds a mapping; it does not touch the fallback.
 *
 * Registration: `{ provide: APP_FILTER, useClass: GadongErrorFilter }` in
 * every service's `AppModule` (module-scoped `@UseFilters` would miss
 * exceptions thrown by a globally-mounted guard the same way a per-route
 * `PermissionGuard` would, so this must be global, matching how
 * `PermissionGuard` itself is registered as `APP_GUARD`).
 */
@Catch(GadongError)
export class GadongErrorFilter implements ExceptionFilter {
  catch(exception: GadongError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<HttpResponseLike>()
    response.status(exception.httpStatus).json(exception.toEnvelope())
  }
}

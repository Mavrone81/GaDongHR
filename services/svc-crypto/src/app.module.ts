import 'reflect-metadata'
import { Module } from '@nestjs/common'
import { APP_FILTER } from '@nestjs/core'
import { GadongErrorFilter } from '@gadong/kernel'
import { CryptoController } from './crypto.controller'
import { CryptoService } from './crypto.service'
import { VAULT_PORT, VaultClient, createHttpVaultTransport, readApproleSecretFromFile } from './vault.client'

/**
 * Deliberately no `{ provide: APP_GUARD, useClass: PermissionGuard }` here
 * — see the comment on `CryptoController` and
 * `crypto.controller.test.ts`'s "AppModule does not mount the kernel
 * PermissionGuard" suite. `svc-crypto` is called service-to-service only.
 *
 * `VAULT_PORT`'s factory reads `VAULT_ADDR`, `VAULT_APPROLE_ID` and the
 * AppRole secret file at `VAULT_APPROLE_SECRET_FILE` once, at DI
 * instantiation time — never logged, never re-read per request.
 */
@Module({
  controllers: [CryptoController],
  providers: [
    CryptoService,
    // Task 16e, defect 2: maps a thrown `GadongError` (e.g.
    // `cryptoUnavailable()`, thrown when Vault is sealed or unreachable, and
    // already translated per-route by `crypto.controller.ts`'s own
    // `runFailClosed`) onto its declared HTTP status/envelope — see kernel
    // `http/gadong-error.filter.ts`. Registered globally as a safety net,
    // not a replacement for that per-route translation.
    { provide: APP_FILTER, useClass: GadongErrorFilter },
    {
      provide: VAULT_PORT,
      useFactory: () => {
        const addr = process.env['VAULT_ADDR'] ?? 'http://127.0.0.1:8200'
        const roleId = process.env['VAULT_APPROLE_ID'] ?? ''
        const secretFile = process.env['VAULT_APPROLE_SECRET_FILE']
        const secretId = secretFile ? readApproleSecretFromFile(secretFile) : ''
        return new VaultClient(createHttpVaultTransport(addr), { addr, roleId, secretId })
      },
    },
  ],
})
export class AppModule {}

import 'reflect-metadata'
import { Module } from '@nestjs/common'
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

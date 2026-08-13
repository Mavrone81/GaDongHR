/**
 * Provisions the real dev-mode Vault container the e2e stack runs: enables
 * the transit engine, creates the two KEKs svc-crypto's own code names
 * (`kek-s2`/`kek-s3` — services/svc-crypto/src/crypto.service.ts's
 * `kekName()`), enables AppRole auth, and mints role-id/secret-id
 * credentials for svc-crypto. Every call here is real Vault HTTP API —
 * nothing about svc-crypto's own Vault client is touched or faked.
 */
const VAULT_ADDR = 'http://127.0.0.1:18200'
const ROOT_TOKEN = 'e2e-root-token'

async function vaultFetch(path: string, opts: { method?: string; body?: unknown } = {}): Promise<unknown> {
  const res = await fetch(`${VAULT_ADDR}${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'X-Vault-Token': ROOT_TOKEN, 'content-type': 'application/json' },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })
  if (!res.ok && res.status !== 404) {
    const text = await res.text()
    throw new Error(`vault ${opts.method ?? 'GET'} ${path} -> ${String(res.status)}: ${text}`)
  }
  if (res.status === 204 || res.status === 404) return null
  const text = await res.text()
  return text.length > 0 ? JSON.parse(text) : null
}

export interface AppRoleCredentials {
  roleId: string
  secretId: string
}

export async function provisionVaultForCrypto(): Promise<AppRoleCredentials> {
  // Idempotent: `sys/mounts` PUT on an already-mounted path 400s "path is
  // already in use" — check first.
  const mounts = (await vaultFetch('/v1/sys/mounts')) as Record<string, unknown> | null
  if (!mounts || !('transit/' in mounts)) {
    await vaultFetch('/v1/sys/mounts/transit', { method: 'POST', body: { type: 'transit' } })
  }

  for (const kek of ['kek-s2', 'kek-s3']) {
    await vaultFetch(`/v1/transit/keys/${kek}`, { method: 'POST', body: {} })
  }

  const authMounts = (await vaultFetch('/v1/sys/auth')) as Record<string, unknown> | null
  if (!authMounts || !('approle/' in authMounts)) {
    await vaultFetch('/v1/sys/auth/approle', { method: 'POST', body: { type: 'approle' } })
  }

  const policy = `
path "transit/datakey/plaintext/kek-*" { capabilities = ["update"] }
path "transit/decrypt/kek-*" { capabilities = ["update"] }
path "transit/hmac/kek-*" { capabilities = ["update"] }
`
  await vaultFetch('/v1/sys/policies/acl/svc-crypto', { method: 'PUT', body: { policy } })

  await vaultFetch('/v1/auth/approle/role/svc-crypto', {
    method: 'POST',
    body: { token_policies: 'svc-crypto', token_ttl: '1h', token_max_ttl: '4h', secret_id_ttl: '0' },
  })

  const roleIdRes = (await vaultFetch('/v1/auth/approle/role/svc-crypto/role-id')) as { data: { role_id: string } }
  const secretIdRes = (await vaultFetch('/v1/auth/approle/role/svc-crypto/secret-id', { method: 'POST' })) as {
    data: { secret_id: string }
  }

  return { roleId: roleIdRes.data.role_id, secretId: secretIdRes.data.secret_id }
}

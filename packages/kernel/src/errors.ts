export class GadongError extends Error {
  constructor(
    readonly code: string,
    readonly messageI18nKey: string,
    readonly httpStatus: number,
    readonly details: unknown[] = [],
  ) {
    super(`${code}: ${messageI18nKey}`)
    this.name = 'GadongError'
  }

  toEnvelope(): { code: string; message_i18n_key: string; details: unknown[] } {
    return { code: this.code, message_i18n_key: this.messageI18nKey, details: this.details }
  }
}

/**
 * Vault sealed or svc-crypto unreachable. The caller must abandon the write.
 * There is deliberately no "skip encryption" path — a plaintext fallback would
 * defeat the product's central guarantee that a DB dump reveals nothing.
 */
export function cryptoUnavailable(): GadongError {
  return new GadongError('CRY-503', 'crypto.error.unavailable', 503)
}

export function permissionDenied(permission: string): GadongError {
  return new GadongError('AUZ-403', 'authz.error.denied', 403, [{ permission }])
}

/** Segregation of duties: same actor on both sides of a two-person control. */
export function sodViolation(rule: string): GadongError {
  return new GadongError('AUZ-409', 'authz.error.sod_violation', 409, [{ rule }])
}

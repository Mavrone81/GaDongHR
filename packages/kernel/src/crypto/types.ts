/** Data classification per docs/superpowers/plans/00-PROGRAM-ROADMAP.md "Data classification → storage treatment". */
export type FieldClass = 'S2' | 'S3'

/** One field to be envelope-encrypted. AAD on the service side is `entityId + ':' + field`. */
export interface EncryptRequest {
  entityId: string
  field: string
  value: string
  fieldClass: FieldClass
}

/**
 * Transport to svc-crypto (Task 6, not yet built). Injectable so this client can be
 * unit-tested against a fake without an HTTP dependency. The real implementation will
 * be an HTTP transport wired up when svc-crypto exists.
 */
export interface CryptoTransport {
  post(path: string, body: unknown): Promise<unknown>
}

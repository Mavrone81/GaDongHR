/**
 * Injectable port to object storage (MinIO in production, per the roadmap).
 * `MinioObjectStorage` (`./minio-storage.ts`) is the real implementation;
 * tests inject `FakeObjectStorage` (`../testing/fake-object-storage.ts`) —
 * there is no MinIO in this environment (CONSTRAINTS: "no MinIO").
 */
export interface ObjectStorage {
  put(bucket: string, key: string, bytes: Buffer): Promise<void>
  get(bucket: string, key: string): Promise<Buffer>
  /** `up` only when the bucket is reachable; never throws — a transport failure is `down`, not an exception the caller must remember to catch. */
  health(): Promise<'up' | 'down'>
}

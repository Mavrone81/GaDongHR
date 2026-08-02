import type { ObjectStorage } from '../storage/object-storage'

/** In-memory stand-in for MinIO — there is no MinIO in this environment (CONSTRAINTS: "no MinIO"). */
export class FakeObjectStorage implements ObjectStorage {
  private readonly objects = new Map<string, Buffer>()
  private healthy = true

  async put(bucket: string, key: string, bytes: Buffer): Promise<void> {
    this.objects.set(`${bucket}/${key}`, bytes)
  }

  async get(bucket: string, key: string): Promise<Buffer> {
    const bytes = this.objects.get(`${bucket}/${key}`)
    if (!bytes) throw new Error(`FakeObjectStorage: no object at ${bucket}/${key}`)
    return bytes
  }

  async health(): Promise<'up' | 'down'> {
    return this.healthy ? 'up' : 'down'
  }

  setHealthy(healthy: boolean): void {
    this.healthy = healthy
  }

  debugKeys(): string[] {
    return [...this.objects.keys()]
  }
}

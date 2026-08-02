import { Client } from 'minio'
import type { ObjectStorage } from './object-storage'

export interface MinioConfig {
  endPoint: string
  port: number
  useSSL: boolean
  accessKey: string
  secretKey: string
}

/**
 * The real, production `ObjectStorage` (roadmap: MinIO holds every
 * generated document; only an encrypted pointer to it — bucket + object
 * key — ever reaches Postgres, per `docs.document.file_ref`'s `bytea`
 * comment in the migration).
 *
 * NOT EXERCISED by this task's test suite: there is no MinIO in this
 * environment (CONSTRAINTS: "no MinIO") — tests inject `FakeObjectStorage`
 * instead. See the task report's "structural vs end-to-end" section.
 */
export class MinioObjectStorage implements ObjectStorage {
  private readonly client: Client

  constructor(config: MinioConfig) {
    this.client = new Client(config)
  }

  async put(bucket: string, key: string, bytes: Buffer): Promise<void> {
    const exists = await this.client.bucketExists(bucket).catch(() => false)
    if (!exists) await this.client.makeBucket(bucket)
    await this.client.putObject(bucket, key, bytes, bytes.length)
  }

  async get(bucket: string, key: string): Promise<Buffer> {
    const stream = await this.client.getObject(bucket, key)
    const chunks: Buffer[] = []
    for await (const chunk of stream) {
      chunks.push(chunk as Buffer)
    }
    return Buffer.concat(chunks)
  }

  async health(): Promise<'up' | 'down'> {
    try {
      await this.client.listBuckets()
      return 'up'
    } catch {
      return 'down'
    }
  }
}

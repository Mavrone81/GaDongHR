import { assertValidSchemaName } from './outbox'
import type { Queryable } from './outbox'

export interface Publisher {
  publish(topic: string, payload: unknown, messageId: string): Promise<void>
}

interface RawOutboxRow {
  id: string
  topic: string
  payload: unknown
}

/**
 * At-least-once relay: drains `<schema>.outbox` and publishes rows whose
 * `published_at IS NULL`. `pool` must be a single dedicated connection (a
 * checked-out client, not a round-robin pool) — SELECT ... FOR UPDATE and
 * the later UPDATE must run on the same session for the lock to hold across
 * the publish call in between. `db/pool.ts` is responsible for handing the
 * relay a connection with that property; this class only issues SQL.
 *
 * `schema` is expected to be a per-service compile-time constant (never
 * user input); the constructor still validates it with
 * `assertValidSchemaName` before it is interpolated into any SQL, since
 * Postgres has no way to bind an identifier as a query parameter.
 */
export class OutboxRelay {
  constructor(
    private readonly pool: Queryable,
    private readonly publisher: Publisher,
    private readonly schema: string,
  ) {
    assertValidSchemaName(schema)
  }

  async drainOnce(batchSize = 50): Promise<{ published: number; failed: number }> {
    let published = 0
    let failed = 0

    await this.pool.query('BEGIN')
    try {
      const { rows } = await this.pool.query(
        `SELECT id, topic, payload, created_at, published_at
         FROM ${this.schema}.outbox
         WHERE published_at IS NULL
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED
         LIMIT $1`,
        [batchSize],
      )

      for (const row of rows as RawOutboxRow[]) {
        try {
          await this.publisher.publish(row.topic, row.payload, row.id)
          // published_at is stamped ONLY after publish resolves successfully.
          // If publish throws we land in the catch below and skip this
          // UPDATE entirely — the row stays NULL for the next drainOnce to
          // retry. Fail closed: never mark a row done before it is actually
          // delivered (Carried-forward binding note; PRD M4-4).
          await this.pool.query(
            `UPDATE ${this.schema}.outbox SET published_at = now() WHERE id = $1`,
            [row.id],
          )
          published += 1
        } catch {
          // One poisoned message must not stall the queue: record the
          // failure and keep draining the rest of the batch instead of
          // throwing out of drainOnce.
          failed += 1
        }
      }

      await this.pool.query('COMMIT')
    } catch (err) {
      await this.pool.query('ROLLBACK')
      throw err
    }

    return { published, failed }
  }
}

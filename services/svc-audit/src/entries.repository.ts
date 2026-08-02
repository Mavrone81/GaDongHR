import type { Queryable } from '@gadong/kernel'
import type { StoredEntry } from './chain'

export const PAGE_SIZE = 50

export interface NewEntryInput {
  occurredAt: string
  actorId: string
  actorRole: string
  action: string
  entity: string
  entityId: string
  purpose: string | null
  beforeHash: string | null
  afterHash: string | null
  prevEntryHash: string
  entryHash: string
}

export interface EntryFilters {
  entity?: string
  entityId?: string
  from?: string
  to?: string
}

const SELECT_COLUMNS = `id, occurred_at, actor_id, actor_role, action, entity, entity_id, purpose,
       before_hash, after_hash, prev_entry_hash, entry_hash`

function toIsoString(v: unknown): string {
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'string') return v
  throw new Error(`EntriesRepository: unexpected timestamp value ${JSON.stringify(v)}`)
}

function nullableString(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v)
}

function mapRow(row: Record<string, unknown>): StoredEntry {
  return {
    id: String(row['id']),
    occurredAt: toIsoString(row['occurred_at']),
    actorId: String(row['actor_id']),
    actorRole: String(row['actor_role']),
    action: String(row['action']),
    entity: String(row['entity']),
    entityId: String(row['entity_id']),
    purpose: nullableString(row['purpose']),
    beforeHash: nullableString(row['before_hash']),
    afterHash: nullableString(row['after_hash']),
    prevEntryHash: String(row['prev_entry_hash']),
    entryHash: String(row['entry_hash']),
  }
}

/**
 * SQL only — no chaining logic here (`chain.ts` owns that), matching the
 * `services/svc-config`/`services/svc-crypto` service/no-SQL split.
 *
 * Deliberately exposes exactly one write method, `insert` — there is no
 * `update`/`delete` anywhere in this class. That is the application-level
 * brace to the migration's DB-level belt (the `audit` role's GRANT has no
 * UPDATE/DELETE at all): even a bug that reused this repository outside its
 * intended call site has no method to call that could rewrite or remove a
 * row (Task 9 brief: "The grants are the point").
 */
export class EntriesRepository {
  constructor(private readonly db: Queryable) {}

  /**
   * The current chain head (highest `id`), or `null` for an empty log.
   * Takes the caller's transaction `tx` explicitly — unlike the read
   * methods below, which use the injected pool — because the consumer must
   * read the head and insert the next entry inside the SAME transaction:
   * two concurrent deliveries reading the head via separate connections
   * could both compute a `prev_entry_hash` pointing at the same
   * predecessor, corrupting the chain. `FOR UPDATE` holds a row lock across
   * that read-then-insert on real Postgres; the fake test double runs
   * single-threaded, so it exercises the SQL shape, not the concurrency
   * property itself.
   */
  async findLatest(tx: Queryable): Promise<StoredEntry | null> {
    const { rows } = await tx.query(`SELECT ${SELECT_COLUMNS} FROM audit.entry ORDER BY id DESC LIMIT 1 FOR UPDATE`)
    return rows.length > 0 && rows[0] !== undefined ? mapRow(rows[0]) : null
  }

  /** Appends one row. The only write this repository has — see the class doc. */
  async insert(tx: Queryable, row: NewEntryInput): Promise<StoredEntry> {
    const { rows } = await tx.query(
      `INSERT INTO audit.entry
         (occurred_at, actor_id, actor_role, action, entity, entity_id, purpose, before_hash, after_hash, prev_entry_hash, entry_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING ${SELECT_COLUMNS}`,
      [
        row.occurredAt,
        row.actorId,
        row.actorRole,
        row.action,
        row.entity,
        row.entityId,
        row.purpose,
        row.beforeHash,
        row.afterHash,
        row.prevEntryHash,
        row.entryHash,
      ],
    )
    const inserted = rows[0]
    if (inserted === undefined) throw new Error('EntriesRepository.insert: INSERT ... RETURNING produced no row')
    return mapRow(inserted)
  }

  /** `GET /entries` — one page (`PAGE_SIZE` rows), oldest first, filtered by whichever of `entity`/`entityId`/`from`/`to` the caller supplied. `page` is 1-based. */
  async findPage(filters: EntryFilters, page: number): Promise<StoredEntry[]> {
    const conditions: string[] = []
    const params: unknown[] = []

    if (filters.entity !== undefined) {
      params.push(filters.entity)
      conditions.push(`entity = $${params.length}`)
    }
    if (filters.entityId !== undefined) {
      params.push(filters.entityId)
      conditions.push(`entity_id = $${params.length}`)
    }
    if (filters.from !== undefined) {
      params.push(filters.from)
      conditions.push(`occurred_at >= $${params.length}`)
    }
    if (filters.to !== undefined) {
      params.push(filters.to)
      conditions.push(`occurred_at <= $${params.length}`)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    params.push(PAGE_SIZE)
    const limitParam = params.length
    params.push((page - 1) * PAGE_SIZE)
    const offsetParam = params.length

    const { rows } = await this.db.query(
      `SELECT ${SELECT_COLUMNS} FROM audit.entry ${where} ORDER BY id ASC LIMIT $${limitParam} OFFSET $${offsetParam}`,
      params,
    )
    return rows.map(mapRow)
  }

  /** Every entry, in chain order (`id ASC` == insertion order) — used only by `/verify`, which must walk the whole chain from genesis. */
  async findAllOrdered(): Promise<StoredEntry[]> {
    const { rows } = await this.db.query(`SELECT ${SELECT_COLUMNS} FROM audit.entry ORDER BY id ASC`)
    return rows.map(mapRow)
  }
}

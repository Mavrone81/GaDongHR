import type { Queryable } from '@gadong/kernel'

export interface DocumentRow {
  id: string
  kind: string
  entityType: string
  entityId: string
  lang: string
  /** Ciphertext (envelope-encrypted MinIO pointer) — see the `bytea`/S3-class comment on `docs.document.file_ref` in the migration. Never plaintext. */
  fileRef: Buffer
  sha256: string
  createdAt: string
}

export interface NewDocumentRow {
  kind: string
  entityType: string
  entityId: string
  lang: string
  fileRef: Buffer
  sha256: string
}

const SELECT_COLUMNS = `id, kind, entity_type, entity_id, lang, file_ref, sha256, created_at`

function toIsoString(v: unknown): string {
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'string') return v
  throw new Error(`DocumentsRepository: unexpected timestamp value ${JSON.stringify(v)}`)
}

function toBuffer(v: unknown): Buffer {
  if (Buffer.isBuffer(v)) return v
  throw new Error(`DocumentsRepository: expected file_ref to be a Buffer (bytea), got ${typeof v}`)
}

function mapRow(row: Record<string, unknown>): DocumentRow {
  return {
    id: String(row['id']),
    kind: String(row['kind']),
    entityType: String(row['entity_type']),
    entityId: String(row['entity_id']),
    lang: String(row['lang']),
    fileRef: toBuffer(row['file_ref']),
    sha256: String(row['sha256']),
    createdAt: toIsoString(row['created_at']),
  }
}

/**
 * SQL only — no business logic (template selection, font checks,
 * encryption) lives here; that is `documents.service.ts`'s job (matching
 * `services/svc-config`'s `service`/no-SQL split). Reads take a plain
 * `Queryable` (bound to the pool at construction — see `app.module.ts`);
 * `insert` takes the CALLER's transaction handle `tx`, so the row and its
 * `document.rendered` outbox event (`documents.service.ts`) commit or roll
 * back together (kernel `writeOutbox`, ADR-005).
 */
export class DocumentsRepository {
  constructor(private readonly db: Queryable) {}

  async findById(id: string): Promise<DocumentRow | null> {
    const { rows } = await this.db.query(`SELECT ${SELECT_COLUMNS} FROM docs.document WHERE id = $1`, [id])
    return rows.length > 0 && rows[0] !== undefined ? mapRow(rows[0]) : null
  }

  async insert(tx: Queryable, row: NewDocumentRow): Promise<DocumentRow> {
    const { rows } = await tx.query(
      `INSERT INTO docs.document (kind, entity_type, entity_id, lang, file_ref, sha256)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${SELECT_COLUMNS}`,
      [row.kind, row.entityType, row.entityId, row.lang, row.fileRef, row.sha256],
    )
    const inserted = rows[0]
    if (inserted === undefined) throw new Error('DocumentsRepository.insert: INSERT ... RETURNING produced no row')
    return mapRow(inserted)
  }
}

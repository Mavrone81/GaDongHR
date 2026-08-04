import type { Queryable } from '@gadong/kernel'
import { toBuffer } from './money-crypto'

/**
 * `payroll.statutory_export` — one row per generated สปส.1-10, PND 1,
 * PND 1 Kor, 50 bis, Kor Ror 11 or bank transfer file.
 *
 * `file_ref` is `bytea` because it is an S3-classified pointer into MinIO,
 * exactly as `docs.document.file_ref` is: the object key of a file
 * containing every employee's salary and national ID is not something to
 * leave readable in a database dump.
 *
 * The Phase 5 migration widened `statutory_export_kind_check` to carry the
 * four bank formats Samuel confirmed alongside the generic CSV. The row is
 * INSERT-blocked by a trigger once its run is committed — which is why
 * exports are generated as part of the commit path, not after it.
 */

export type ExportKind =
  | 'sso_1_10'
  | 'pnd1'
  | 'pnd1kor'
  | '50bis'
  | 'kor_ror_11'
  | 'bank_csv'
  | 'bank_kbank'
  | 'bank_scb'
  | 'bank_bbl'
  | 'bank_krungsri'

export interface StatutoryExportRow {
  id: string
  runId: string
  kind: ExportKind
  fileRef: Buffer
  status: 'generated' | 'downloaded'
}

export class ExportsRepository {
  constructor(private readonly db: Queryable) {}

  async insert(tx: Queryable, row: Omit<StatutoryExportRow, 'status'>): Promise<StatutoryExportRow> {
    const { rows } = await tx.query(
      `INSERT INTO payroll.statutory_export (id, run_id, kind, file_ref, status) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [row.id, row.runId, row.kind, row.fileRef, 'generated'],
    )
    const first = rows[0]
    if (first === undefined) throw new Error('ExportsRepository.insert: INSERT ... RETURNING * returned no row')
    return this.map(first as Record<string, unknown>)
  }

  async listByRun(runId: string, db: Queryable = this.db): Promise<StatutoryExportRow[]> {
    const { rows } = await db.query('SELECT * FROM payroll.statutory_export WHERE run_id = $1 ORDER BY id', [runId])
    return rows.map((r) => this.map(r as Record<string, unknown>))
  }

  private map(row: Record<string, unknown>): StatutoryExportRow {
    const fileRef = toBuffer(row['file_ref'])
    if (fileRef === null) throw new Error('ExportsRepository: file_ref is notNull in the schema but came back null')
    return {
      id: String(row['id']),
      runId: String(row['run_id']),
      kind: row['kind'] as ExportKind,
      fileRef,
      status: row['status'] as 'generated' | 'downloaded',
    }
  }
}

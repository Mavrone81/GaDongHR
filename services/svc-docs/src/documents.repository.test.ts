import type { Queryable } from '@gadong/kernel'
import { DocumentsRepository } from './documents.repository'
import type { NewDocumentRow } from './documents.repository'
import { FakeDocsDb } from './testing/fake-db'

function newRow(overrides: Partial<NewDocumentRow> = {}): NewDocumentRow {
  return {
    kind: 'payslip',
    entityType: 'employee',
    entityId: 'emp-1',
    lang: 'th',
    fileRef: Buffer.alloc(125, 7),
    sha256: 'a'.repeat(64),
    ...overrides,
  }
}

describe('DocumentsRepository — SQL shape (mocked tx)', () => {
  it('insert() issues an INSERT into docs.document with file_ref passed through as the raw Buffer (bytea, not base64/text)', async () => {
    const returned = {
      id: 'doc-1',
      kind: 'payslip',
      entity_type: 'employee',
      entity_id: 'emp-1',
      lang: 'th',
      file_ref: Buffer.alloc(125, 7),
      sha256: 'a'.repeat(64),
      created_at: new Date('2026-08-02T00:00:00Z'),
    }
    const tx: Queryable = { query: jest.fn().mockResolvedValue({ rows: [returned] }) }
    const repo = new DocumentsRepository(tx)

    const row = await repo.insert(tx, newRow())

    expect(tx.query).toHaveBeenCalledTimes(1)
    const [sql, params] = (tx.query as jest.Mock).mock.calls[0] as [string, unknown[]]
    expect(sql).toMatch(/INSERT INTO docs\.document/i)
    expect(params[0]).toBe('payslip')
    expect(params[4]).toBeInstanceOf(Buffer)
    expect(row).toMatchObject({ id: 'doc-1', kind: 'payslip', entityId: 'emp-1', lang: 'th' })
    expect(row.fileRef).toBeInstanceOf(Buffer)
  })

  it('insert() throws if INSERT ... RETURNING somehow produces no row', async () => {
    const tx: Queryable = { query: jest.fn().mockResolvedValue({ rows: [] }) }
    const repo = new DocumentsRepository(tx)
    await expect(repo.insert(tx, newRow())).rejects.toThrow(/produced no row/)
  })

  it('findById() selects by id and returns null when nothing matches', async () => {
    const tx: Queryable = { query: jest.fn().mockResolvedValue({ rows: [] }) }
    const repo = new DocumentsRepository(tx)

    const row = await repo.findById('missing')

    expect(row).toBeNull()
    const [sql, params] = (tx.query as jest.Mock).mock.calls[0] as [string, unknown[]]
    expect(sql).toMatch(/FROM docs\.document WHERE id = \$1/i)
    expect(params).toEqual(['missing'])
  })
})

describe('DocumentsRepository — against FakeDocsDb (transaction staging behaviour)', () => {
  it('a row inserted inside BEGIN...COMMIT is visible afterwards via findById', async () => {
    const db = new FakeDocsDb()
    const conn = db.connect()
    const repo = new DocumentsRepository(conn)

    await conn.query('BEGIN')
    const inserted = await repo.insert(conn, newRow())
    await conn.query('COMMIT')

    const found = await repo.findById(inserted.id)
    expect(found).toEqual(inserted)
  })

  it('a row inserted then ROLLBACK is never visible', async () => {
    const db = new FakeDocsDb()
    const conn = db.connect()
    const repo = new DocumentsRepository(conn)

    await conn.query('BEGIN')
    const inserted = await repo.insert(conn, newRow())
    await conn.query('ROLLBACK')

    const found = await repo.findById(inserted.id)
    expect(found).toBeNull()
  })
})

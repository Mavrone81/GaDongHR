import { randomUUID } from 'node:crypto'
import { SecurityEventRepository } from './security-event.repository'
import { FakeAttendanceDb } from './testing/fake-attendance-db'

describe('SecurityEventRepository', () => {
  it('records a liveness_failed event with no image/frame data', async () => {
    const db = new FakeAttendanceDb()
    const repo = new SecurityEventRepository(db.asPool())
    const tx = db.connect()
    await tx.query('BEGIN')
    const row = await repo.insert(tx, {
      id: randomUUID(), kind: 'liveness_failed', deviceId: 'device-1', employeeId: null, siteCode: 'BKK-HQ', at: '2026-01-01T00:00:00.000Z',
    })
    await tx.query('COMMIT')

    expect(row).toMatchObject({ kind: 'liveness_failed', deviceId: 'device-1', siteCode: 'BKK-HQ' })
    expect(Object.keys(row)).not.toContain('frame')
  })

  it('listByKind filters — a GET /security-events?kind=liveness_failed query never returns multi_face rows', async () => {
    const db = new FakeAttendanceDb()
    const repo = new SecurityEventRepository(db.asPool())
    for (const kind of ['liveness_failed', 'multi_face', 'liveness_failed'] as const) {
      const tx = db.connect()
      await tx.query('BEGIN')
      await repo.insert(tx, { id: randomUUID(), kind, deviceId: 'device-1', employeeId: null, siteCode: 'BKK-HQ', at: new Date().toISOString() })
      await tx.query('COMMIT')
    }

    const rows = await repo.listByKind(db.asPool(), 'liveness_failed')
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.kind === 'liveness_failed')).toBe(true)
  })
})

import type { Queryable } from '@gadong/kernel'
import { NotifyRepository } from './notify.repository'

describe('NotifyRepository — SQL shape (mocked tx)', () => {
  it('insertNotification() issues an INSERT into notify.notification and returns the mapped row', async () => {
    const returned = {
      id: 'notif-1',
      recipient_user_id: 'user-1',
      kind: 'leave.approved',
      lang: 'th',
      subject: 'subject',
      body: 'body',
      read_at: null,
      created_at: new Date('2026-08-01T00:00:00Z'),
    }
    const tx: Queryable = { query: jest.fn().mockResolvedValue({ rows: [returned] }) }
    const repo = new NotifyRepository(tx)

    const row = await repo.insertNotification(tx, {
      recipientUserId: 'user-1',
      kind: 'leave.approved',
      lang: 'th',
      subject: 'subject',
      body: 'body',
    })

    expect(tx.query).toHaveBeenCalledTimes(1)
    const [sql, params] = (tx.query as jest.Mock).mock.calls[0] as [string, unknown[]]
    expect(sql).toMatch(/INSERT INTO notify\.notification/i)
    expect(params).toEqual(['user-1', 'leave.approved', 'th', 'subject', 'body'])
    expect(row).toMatchObject({ id: 'notif-1', recipientUserId: 'user-1', kind: 'leave.approved', lang: 'th', readAt: null })
  })

  it('insertDelivery() issues an INSERT into notify.delivery carrying the "sent" flag as the 6th parameter', async () => {
    const returned = {
      id: 'delivery-1',
      notification_id: 'notif-1',
      channel: 'email',
      status: 'failed',
      attempts: 1,
      last_error: 'ECONNREFUSED',
      sent_at: null,
    }
    const tx: Queryable = { query: jest.fn().mockResolvedValue({ rows: [returned] }) }
    const repo = new NotifyRepository(tx)

    const row = await repo.insertDelivery(tx, {
      notificationId: 'notif-1',
      channel: 'email',
      status: 'failed',
      attempts: 1,
      lastError: 'ECONNREFUSED',
      sent: false,
    })

    const [sql, params] = (tx.query as jest.Mock).mock.calls[0] as [string, unknown[]]
    expect(sql).toMatch(/INSERT INTO notify\.delivery/i)
    expect(params).toEqual(['notif-1', 'email', 'failed', 1, 'ECONNREFUSED', false])
    expect(row).toMatchObject({ id: 'delivery-1', status: 'failed', lastError: 'ECONNREFUSED', sentAt: null })
  })

  it('listByRecipient(unreadOnly=true) filters on read_at IS NULL', async () => {
    const tx: Queryable = { query: jest.fn().mockResolvedValue({ rows: [] }) }
    const repo = new NotifyRepository(tx)

    await repo.listByRecipient('user-1', true)

    const [sql, params] = (tx.query as jest.Mock).mock.calls[0] as [string, unknown[]]
    expect(sql).toMatch(/read_at IS NULL/i)
    expect(params).toEqual(['user-1'])
  })

  it('listByRecipient(unreadOnly=false) does not filter on read_at', async () => {
    const tx: Queryable = { query: jest.fn().mockResolvedValue({ rows: [] }) }
    const repo = new NotifyRepository(tx)

    await repo.listByRecipient('user-1', false)

    const [sql] = (tx.query as jest.Mock).mock.calls[0] as [string, unknown[]]
    expect(sql).not.toMatch(/read_at IS NULL/i)
  })

  it('markRead() scopes the UPDATE to both id and recipient_user_id (self-scoping)', async () => {
    const tx: Queryable = { query: jest.fn().mockResolvedValue({ rows: [] }) }
    const repo = new NotifyRepository(tx)

    await repo.markRead(tx, 'notif-1', 'user-1')

    const [sql, params] = (tx.query as jest.Mock).mock.calls[0] as [string, unknown[]]
    expect(sql).toMatch(/UPDATE notify\.notification/i)
    expect(sql).toMatch(/WHERE id = \$1 AND recipient_user_id = \$2/i)
    expect(params).toEqual(['notif-1', 'user-1'])
  })

  it('markRead() returns null when the UPDATE matches no row', async () => {
    const tx: Queryable = { query: jest.fn().mockResolvedValue({ rows: [] }) }
    const repo = new NotifyRepository(tx)

    const row = await repo.markRead(tx, 'notif-1', 'user-1')

    expect(row).toBeNull()
  })

  it('upsertRecipientPref() issues an INSERT ... ON CONFLICT DO UPDATE', async () => {
    const tx: Queryable = { query: jest.fn().mockResolvedValue({ rows: [] }) }
    const repo = new NotifyRepository(tx)

    await repo.upsertRecipientPref(tx, 'user-1', 'th')

    const [sql, params] = (tx.query as jest.Mock).mock.calls[0] as [string, unknown[]]
    expect(sql).toMatch(/INSERT INTO notify\.recipient_pref/i)
    expect(sql).toMatch(/ON CONFLICT \(user_id\) DO UPDATE/i)
    expect(params).toEqual(['user-1', 'th'])
  })

  it('getRecipientPref() returns null when no row exists', async () => {
    const tx: Queryable = { query: jest.fn().mockResolvedValue({ rows: [] }) }
    const repo = new NotifyRepository(tx)

    const lang = await repo.getRecipientPref('user-1')

    expect(lang).toBeNull()
  })

  it('getRecipientPref() returns the stored lang when a row exists', async () => {
    const tx: Queryable = { query: jest.fn().mockResolvedValue({ rows: [{ lang: 'zh' }] }) }
    const repo = new NotifyRepository(tx)

    const lang = await repo.getRecipientPref('user-1')

    expect(lang).toBe('zh')
  })
})

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Queryable } from '@gadong/kernel'
import { NotifyService, NotificationNotFound, placeholderEmailAddress } from './notify.service'
import type { EmailTransport, EmployeeCreatedPayload, LeaveApprovedPayload, ClaimApprovedForPayrollPayload, PayslipIssuedPayload } from './notify.service'
import { NotifyRepository } from './notify.repository'
import { TemplateRenderer } from './templates'
import type { Logger } from './templates'
import { FakeNotifyDb } from './testing/fake-db'

class FakeEmailTransport implements EmailTransport {
  calls: Array<{ to: string; subject: string; body: string }> = []
  sendImpl: (message: { to: string; subject: string; body: string }) => Promise<void> = async () => {}

  async send(message: { to: string; subject: string; body: string }): Promise<void> {
    this.calls.push(message)
    await this.sendImpl(message)
  }

  async verify(): Promise<boolean> {
    return true
  }
}

function employeeCreated(overrides: Partial<EmployeeCreatedPayload> = {}): EmployeeCreatedPayload {
  return {
    id: 'emp-1',
    empCode: 'E001',
    orgUnitId: 'org-1',
    employmentType: 'permanent',
    provinceCode: 'TH-10',
    startDate: '2026-01-01',
    status: 'active',
    preferredLang: 'th',
    ...overrides,
  }
}

function leaveApproved(overrides: Partial<LeaveApprovedPayload> = {}): LeaveApprovedPayload {
  return {
    requestId: 'req-1',
    employeeId: 'emp-1',
    leaveTypeCode: 'annual',
    dates: ['2026-08-10'],
    days: 1,
    payMode: 'paid',
    ...overrides,
  }
}

function claimApproved(overrides: Partial<ClaimApprovedForPayrollPayload> = {}): ClaimApprovedForPayrollPayload {
  return {
    claimId: 'claim-1',
    employeeId: 'emp-1',
    amountThb: 1500.5,
    claimType: 'medical',
    ...overrides,
  }
}

function payslipIssued(overrides: Partial<PayslipIssuedPayload> = {}): PayslipIssuedPayload {
  return {
    payslipId: 'payslip-1',
    runId: 'run-1',
    employeeId: 'emp-1',
    lang: 'en',
    ...overrides,
  }
}

/** Real shipped templates (`services/svc-notify/templates`) — used for every test that doesn't need a deliberately-broken fixture. */
function harness(tenantDefaultLang: 'th' | 'en' | 'zh' = 'th') {
  const db = new FakeNotifyDb()
  const conn = db.connect()
  const repo = new NotifyRepository(conn)
  const emailTransport = new FakeEmailTransport()
  const templates = new TemplateRenderer()
  const service = new NotifyService(repo, emailTransport, templates, tenantDefaultLang)
  return { db, conn, repo, emailTransport, templates, service }
}

async function inTx<T>(conn: Queryable, fn: () => Promise<T>): Promise<T> {
  await conn.query('BEGIN')
  try {
    const result = await fn()
    await conn.query('COMMIT')
    return result
  } catch (err) {
    await conn.query('ROLLBACK')
    throw err
  }
}

describe('Language is the RECIPIENT\'s, not the actor\'s', () => {
  it('a Thai-preferring employee whose leave is approved receives Thai, even though a different (English-preferring) user exists in the system as the approving manager', async () => {
    const { db, conn, service } = harness()

    // The recipient: a Thai-speaking factory worker.
    await inTx(conn, () => service.handleEmployeeCreated(conn, 'evt-emp-worker', employeeCreated({ id: 'emp-th', preferredLang: 'th' })))
    // A different real user in the system — the line manager who will approve the leave — prefers English.
    // `leave.approved`'s payload (roadmap "Event catalog") carries no approver id at all, so there is
    // structurally no way for `notifyLeaveApproved` to reach for it — this row exists purely to prove
    // that having an English-preferring actor's preference on hand does not leak into the recipient's
    // notification.
    await inTx(conn, () => service.handleEmployeeCreated(conn, 'evt-emp-manager', employeeCreated({ id: 'mgr-en', preferredLang: 'en' })))

    await inTx(conn, () => service.handleLeaveApproved(conn, 'evt-leave-1', leaveApproved({ employeeId: 'emp-th' })))

    const notifications = db.debugNotifications()
    expect(notifications).toHaveLength(1)
    expect(notifications[0]?.recipient_user_id).toBe('emp-th')
    expect(notifications[0]?.lang).toBe('th')
    expect(notifications[0]?.lang).not.toBe('en')
  })
})

describe('Duplicate delivery sends exactly one email', () => {
  it('the same leave.approved event delivered three times produces one notification and exactly one SMTP send', async () => {
    const { db, conn, service, emailTransport } = harness()
    await inTx(conn, () => service.handleEmployeeCreated(conn, 'evt-emp', employeeCreated({ id: 'emp-1', preferredLang: 'en' })))

    for (let i = 0; i < 3; i++) {
      await inTx(conn, () => service.handleLeaveApproved(conn, 'evt-leave-dup', leaveApproved()))
    }

    expect(db.debugNotifications()).toHaveLength(1)
    expect(emailTransport.calls).toHaveLength(1)
    // Belt: the in-app row and its delivery rows also number exactly one each.
    const deliveries = db.debugDeliveries()
    expect(deliveries.filter((d) => d.channel === 'email')).toHaveLength(1)
    expect(deliveries.filter((d) => d.channel === 'in_app')).toHaveLength(1)
  })

  it('duplicate delivery of claim.approved_for_payroll and payslip.issued is equally deduped', async () => {
    const { db, conn, service, emailTransport } = harness()

    for (let i = 0; i < 3; i++) {
      await inTx(conn, () => service.handleClaimApprovedForPayroll(conn, 'evt-claim-dup', claimApproved()))
    }
    for (let i = 0; i < 3; i++) {
      await inTx(conn, () => service.handlePayslipIssued(conn, 'evt-payslip-dup', payslipIssued()))
    }

    expect(db.debugNotifications()).toHaveLength(2) // one claim notification, one payslip notification
    expect(emailTransport.calls).toHaveLength(2)
  })
})

describe('No language preference falls back to the tenant default, not English-by-accident', () => {
  it('an employee with no known preference (no employee.created ever seen) gets the tenant default language', async () => {
    const { db, conn, service } = harness('th') // tenant default is Thai — the whole point of this test

    await inTx(conn, () => service.handleLeaveApproved(conn, 'evt-leave-nopref', leaveApproved({ employeeId: 'emp-unknown' })))

    const notifications = db.debugNotifications()
    expect(notifications).toHaveLength(1)
    expect(notifications[0]?.lang).toBe('th')
    expect(notifications[0]?.lang).not.toBe('en')
  })

  it('a different tenant default (zh) is honoured too — proves this is a real fallback, not a hard-coded th', async () => {
    const { db, conn, service } = harness('zh')

    await inTx(conn, () => service.handleLeaveApproved(conn, 'evt-leave-nopref-zh', leaveApproved({ employeeId: 'emp-unknown' })))

    expect(db.debugNotifications()[0]?.lang).toBe('zh')
  })
})

describe('SMTP failure marks delivery failed but never loses the in-app notification', () => {
  it('records channel=email status=failed with the error, and channel=in_app status=sent, from the same event', async () => {
    const { db, conn, service, emailTransport } = harness()
    emailTransport.sendImpl = async () => {
      throw new Error('ECONNREFUSED: smtp relay unreachable')
    }

    await inTx(conn, () => service.handleLeaveApproved(conn, 'evt-leave-smtp-fail', leaveApproved({ employeeId: 'emp-1' })))

    expect(db.debugNotifications()).toHaveLength(1) // the worker still sees it in the app
    const deliveries = db.debugDeliveries()
    const emailDelivery = deliveries.find((d) => d.channel === 'email')
    const inAppDelivery = deliveries.find((d) => d.channel === 'in_app')
    expect(emailDelivery).toMatchObject({ status: 'failed', last_error: 'ECONNREFUSED: smtp relay unreachable' })
    expect(inAppDelivery).toMatchObject({ status: 'sent' })
  })
})

describe('SMTP failure does not roll back or retry the consumed event', () => {
  it('the event is marked processed despite the SMTP failure — redelivering the SAME event id sends no second email', async () => {
    const { db, conn, service, emailTransport } = harness()
    emailTransport.sendImpl = async () => {
      throw new Error('smtp down')
    }

    await inTx(conn, () => service.handleLeaveApproved(conn, 'evt-leave-noretry', leaveApproved({ employeeId: 'emp-1' })))
    expect(emailTransport.calls).toHaveLength(1)
    expect(db.debugNotifications()).toHaveLength(1)

    // Redeliver the identical event id — a broker-level retry, or this consumer simply being invoked
    // again for the same message. If the failure had rolled back the transaction, `processed_events`
    // would be empty and this second call would run the handler again, sending ANOTHER email.
    await inTx(conn, () => service.handleLeaveApproved(conn, 'evt-leave-noretry', leaveApproved({ employeeId: 'emp-1' })))

    expect(emailTransport.calls).toHaveLength(1) // still exactly one attempt — no retry happened
    expect(db.debugNotifications()).toHaveLength(1) // no second notification either
  })

  it('one recipient\'s SMTP failure does not block or re-notify a different recipient in the same run', async () => {
    const { db, conn, service, emailTransport } = harness()
    await inTx(conn, () => service.handleEmployeeCreated(conn, 'evt-emp-a', employeeCreated({ id: 'emp-a', preferredLang: 'en' })))
    await inTx(conn, () => service.handleEmployeeCreated(conn, 'evt-emp-b', employeeCreated({ id: 'emp-b', preferredLang: 'en' })))

    emailTransport.sendImpl = async (message) => {
      if (message.to === placeholderEmailAddress('emp-a')) throw new Error('emp-a mailbox full')
    }

    await inTx(conn, () => service.handleLeaveApproved(conn, 'evt-leave-a', leaveApproved({ employeeId: 'emp-a' })))
    await inTx(conn, () => service.handleLeaveApproved(conn, 'evt-leave-b', leaveApproved({ employeeId: 'emp-b' })))

    expect(db.debugNotifications()).toHaveLength(2)
    const deliveries = db.debugDeliveries().filter((d) => d.channel === 'email')
    const forA = deliveries.find((d) => db.debugNotifications().find((n) => n.id === d.notification_id)?.recipient_user_id === 'emp-a')
    const forB = deliveries.find((d) => db.debugNotifications().find((n) => n.id === d.notification_id)?.recipient_user_id === 'emp-b')
    expect(forA?.status).toBe('failed')
    expect(forB?.status).toBe('sent')
  })
})

describe('A template missing for the recipient\'s language falls back to English and logs a warning', () => {
  it('falls back and the stored notification.lang reflects English, not the originally-requested language', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'svc-notify-service-templates-'))
    writeFileSync(join(dir, 'leave.approved.en.json'), JSON.stringify({ subject: 'EN subject', body: 'EN body {{days}}' }))
    // Deliberately no leave.approved.zh.json.
    const warnings: Array<{ message: string; meta?: Record<string, unknown> }> = []
    const logger: Logger = { warn: (message, meta) => warnings.push({ message, meta }) }

    const db = new FakeNotifyDb()
    const conn = db.connect()
    const repo = new NotifyRepository(conn)
    const emailTransport = new FakeEmailTransport()
    const templates = new TemplateRenderer(logger, dir)
    const service = new NotifyService(repo, emailTransport, templates, 'en')

    await inTx(conn, () => service.handleEmployeeCreated(conn, 'evt-emp-zh', employeeCreated({ id: 'emp-zh', preferredLang: 'zh' })))
    await inTx(conn, () => service.handleLeaveApproved(conn, 'evt-leave-zh', leaveApproved({ employeeId: 'emp-zh' })))

    const notification = db.debugNotifications()[0]
    expect(notification?.lang).toBe('en')
    expect(notification?.subject).toBe('EN subject')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.meta).toMatchObject({ kind: 'leave.approved', lang: 'zh' })
  })
})

describe('Buddhist Era dates in Thai notifications, Gregorian in English and Chinese — using the kernel formatter', () => {
  it('a Thai recipient sees the B.E. year (2026 -> 2569); English and Chinese recipients see the Gregorian year', async () => {
    const { db, conn, service } = harness()
    await inTx(conn, () => service.handleEmployeeCreated(conn, 'evt-emp-th', employeeCreated({ id: 'emp-th', preferredLang: 'th' })))
    await inTx(conn, () => service.handleEmployeeCreated(conn, 'evt-emp-en', employeeCreated({ id: 'emp-en', preferredLang: 'en' })))
    await inTx(conn, () => service.handleEmployeeCreated(conn, 'evt-emp-zh', employeeCreated({ id: 'emp-zh', preferredLang: 'zh' })))

    await inTx(conn, () => service.handleLeaveApproved(conn, 'evt-leave-th', leaveApproved({ employeeId: 'emp-th', dates: ['2026-08-10'] })))
    await inTx(conn, () => service.handleLeaveApproved(conn, 'evt-leave-en', leaveApproved({ employeeId: 'emp-en', dates: ['2026-08-10'] })))
    await inTx(conn, () => service.handleLeaveApproved(conn, 'evt-leave-zh', leaveApproved({ employeeId: 'emp-zh', dates: ['2026-08-10'] })))

    const byRecipient = new Map(db.debugNotifications().map((n) => [n.recipient_user_id, n]))
    expect(byRecipient.get('emp-th')?.body).toContain('2569')
    expect(byRecipient.get('emp-th')?.body).not.toContain('2026')
    expect(byRecipient.get('emp-en')?.body).toContain('2026')
    expect(byRecipient.get('emp-en')?.body).not.toContain('2569')
    expect(byRecipient.get('emp-zh')?.body).toContain('2026')
    expect(byRecipient.get('emp-zh')?.body).not.toContain('2569')
  })
})

describe('claim.approved_for_payroll renders THB via the kernel money formatter', () => {
  it('renders 1500.50 THB using formatTHB, not a hand-rolled format', async () => {
    const { db, conn, service } = harness()
    await inTx(conn, () => service.handleEmployeeCreated(conn, 'evt-emp', employeeCreated({ id: 'emp-1', preferredLang: 'en' })))

    await inTx(conn, () => service.handleClaimApprovedForPayroll(conn, 'evt-claim-1', claimApproved({ amountThb: 1500.5 })))

    expect(db.debugNotifications()[0]?.body).toContain('฿1,500.50')
  })
})

describe('payslip.issued ignores the producer-supplied lang field and uses the recipient\'s own preference', () => {
  it('a Thai-preferring recipient gets a Thai payslip notification even though the event\'s own lang field says "en"', async () => {
    const { db, conn, service } = harness()
    await inTx(conn, () => service.handleEmployeeCreated(conn, 'evt-emp', employeeCreated({ id: 'emp-1', preferredLang: 'th' })))

    await inTx(conn, () => service.handlePayslipIssued(conn, 'evt-payslip-1', payslipIssued({ employeeId: 'emp-1', lang: 'en' })))

    expect(db.debugNotifications()[0]?.lang).toBe('th')
  })
})

describe('employee.created with no usable preferredLang is a no-op on the read model, not an error', () => {
  it('an absent preferredLang does not throw and leaves no recipient_pref row', async () => {
    const { db, conn, service } = harness()

    await expect(
      inTx(conn, () => service.handleEmployeeCreated(conn, 'evt-emp-nolang', employeeCreated({ id: 'emp-x', preferredLang: null }))),
    ).resolves.toBeUndefined()

    expect(db.debugRecipientPref('emp-x')).toBeNull()
  })

  it('an invalid preferredLang value is ignored rather than stored', async () => {
    const { db, conn, service } = harness()

    await inTx(conn, () => service.handleEmployeeCreated(conn, 'evt-emp-bad', employeeCreated({ id: 'emp-y', preferredLang: 'fr' })))

    expect(db.debugRecipientPref('emp-y')).toBeNull()
  })
})

describe('NotifyService.listNotifications / markRead — self-scoping', () => {
  it('listNotifications only returns the given recipient\'s own notifications', async () => {
    const { db, conn, service } = harness()
    await inTx(conn, () => service.handleEmployeeCreated(conn, 'evt-emp-a', employeeCreated({ id: 'emp-a', preferredLang: 'en' })))
    await inTx(conn, () => service.handleEmployeeCreated(conn, 'evt-emp-b', employeeCreated({ id: 'emp-b', preferredLang: 'en' })))
    await inTx(conn, () => service.handleLeaveApproved(conn, 'evt-leave-a', leaveApproved({ employeeId: 'emp-a' })))
    await inTx(conn, () => service.handleLeaveApproved(conn, 'evt-leave-b', leaveApproved({ employeeId: 'emp-b' })))

    const forA = await service.listNotifications('emp-a', false)

    expect(forA).toHaveLength(1)
    expect(forA[0]?.recipientUserId).toBe('emp-a')
    void db
  })

  it('markRead() throws NotificationNotFound for a notification belonging to someone else', async () => {
    const { conn, service } = harness()
    await inTx(conn, () => service.handleEmployeeCreated(conn, 'evt-emp-a', employeeCreated({ id: 'emp-a', preferredLang: 'en' })))
    await inTx(conn, () => service.handleLeaveApproved(conn, 'evt-leave-a', leaveApproved({ employeeId: 'emp-a' })))
    const [notification] = await service.listNotifications('emp-a', false)
    if (!notification) throw new Error('expected a notification to exist')

    await expect(inTx(conn, () => service.markRead(conn, notification.id, 'someone-else'))).rejects.toBeInstanceOf(NotificationNotFound)
  })

  it('markRead() sets read_at for the owning recipient and is idempotent on a second call', async () => {
    const { conn, service } = harness()
    await inTx(conn, () => service.handleEmployeeCreated(conn, 'evt-emp-a', employeeCreated({ id: 'emp-a', preferredLang: 'en' })))
    await inTx(conn, () => service.handleLeaveApproved(conn, 'evt-leave-a', leaveApproved({ employeeId: 'emp-a' })))
    const [notification] = await service.listNotifications('emp-a', false)
    if (!notification) throw new Error('expected a notification to exist')

    const first = await inTx(conn, () => service.markRead(conn, notification.id, 'emp-a'))
    const second = await inTx(conn, () => service.markRead(conn, notification.id, 'emp-a'))

    expect(first.readAt).not.toBeNull()
    expect(second.readAt).toBe(first.readAt)

    const unread = await service.listNotifications('emp-a', true)
    expect(unread).toHaveLength(0)
  })
})

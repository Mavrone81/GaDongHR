import { formatDate, formatTHB, idempotent } from '@gadong/kernel'
import type { Locale, Queryable } from '@gadong/kernel'
import { NotifyRepository } from './notify.repository'
import type { NotificationRow } from './notify.repository'
import { TemplateRenderer } from './templates'

/**
 * Injectable so tests run against a fake and never touch a real mailbox —
 * the same shape as kernel's `CryptoTransport`/`AuthzTransport` (Task 11
 * brief constraints: "no real SMTP here — inject both transports").
 * `verify()` backs `GET /health`'s `smtp` dependency check without sending
 * a message.
 */
export interface EmailTransport {
  send(message: { to: string; subject: string; body: string }): Promise<void>
  verify(): Promise<boolean>
}

export class NotificationNotFound extends Error {
  constructor(id: string) {
    super(`notification not found: ${id}`)
    this.name = 'NotificationNotFound'
  }
}

export interface EmployeeCreatedPayload {
  id: string
  empCode: string
  orgUnitId: string
  employmentType: string
  provinceCode: string
  startDate: string
  status: string
  preferredLang?: string | null
}

export interface LeaveApprovedPayload {
  requestId: string
  employeeId: string
  leaveTypeCode: string
  /** ISO-8601 dates the leave covers — not assumed contiguous (e.g. two half-days). Rendered as a `startDate`–`endDate` span; `days` (below) carries the actual count. */
  dates: string[]
  days: number
  payMode: string
}

export interface ClaimApprovedForPayrollPayload {
  claimId: string
  employeeId: string
  amountThb: number
  claimType: string
}

export interface PayslipIssuedPayload {
  payslipId: string
  runId: string
  employeeId: string
  /**
   * The PRODUCER's (payroll's) language choice for the payslip document
   * itself. Deliberately UNUSED for this notification's own language —
   * this service resolves the recipient's language itself (`resolveLang`,
   * below), the same as every other event it consumes. Trusting a
   * producer-supplied `lang` field would reintroduce exactly the
   * actor-vs-recipient confusion the Task 11 brief calls out as "the
   * single easiest thing to get backwards": nothing here distinguishes
   * "the producer's language" from "the recipient's language" for THIS
   * event, so it must not special-case one event to trust the payload over
   * its own local read model.
   */
  lang: string
}

/** `GaDongHR`'s onboarding service does not exist yet in this codebase (Phase 1 builds the platform services only — roadmap "Program roadmap"), and no event in the catalog this service consumes carries an email address at all: `employee.created`'s payload (`{id, empCode, orgUnitId, employmentType, provinceCode, startDate, status, preferredLang}`) has none, and email is S2-class PII the catalog says must be "fetched by ID through the owning service's audited API" — an API that has nothing to call yet. Until it exists, `to` is a synthetic address derived from the recipient's user id, so this service's actual contract (render in the recipient's language, dedupe on event id, exactly one SMTP send per notification, the in-app row survives an SMTP failure) is provably correct today against a real `EmailTransport` shape. Swapping in a real address lookup is a one-line change at this call site, not a redesign — see task-11-report.md, "deviations". */
export function placeholderEmailAddress(recipientUserId: string): string {
  return `${recipientUserId}@users.gadonghr.invalid`
}

function isLocale(v: unknown): v is Locale {
  return v === 'th' || v === 'en' || v === 'zh'
}

/** Money arrives as a plain THB number on `claim.approved_for_payroll` (roadmap "Event catalog": `amountThb`), not the `bigint` satang the payroll engine itself uses internally — this is a notification's display copy, not a ledger figure, so the round-trip through the kernel's `formatTHB` (which wants satang) is display-only and never written anywhere. */
function thbToSatang(amountThb: number): bigint {
  return BigInt(Math.round(amountThb * 100))
}

/**
 * Consumes `leave.approved`, `claim.approved_for_payroll`, `payslip.issued`
 * and `employee.created` (Task 11 brief). Every `handle*` method is the
 * caller's transaction handle `tx` wrapped in the kernel's `idempotent()`
 * against `notify.processed_events` — triple delivery of the same event id
 * runs the handler exactly once (XC-EVENTS), which is also why "duplicate
 * delivery sends exactly one email" needs no bespoke dedupe logic of its
 * own: the second and third deliveries never reach `emailTransport.send`
 * because `idempotent`'s handler never runs for them at all.
 *
 * No event handler here can roll back the whole batch over one bad
 * mailbox: an SMTP failure is caught inside `deliver()` and turned into a
 * `failed` delivery row, never rethrown, so `idempotent`'s transaction
 * still commits — the in-app notification is never lost, and the consumed
 * event is never redelivered (which would re-notify everyone else in the
 * batch a second time).
 */
export class NotifyService {
  constructor(
    private readonly repo: NotifyRepository,
    private readonly emailTransport: EmailTransport,
    private readonly templates: TemplateRenderer,
    private readonly tenantDefaultLang: Locale,
  ) {}

  async handleEmployeeCreated(tx: Queryable, eventId: string, payload: EmployeeCreatedPayload): Promise<void> {
    await idempotent(tx, 'notify', eventId, async () => {
      if (isLocale(payload.preferredLang)) {
        await this.repo.upsertRecipientPref(tx, payload.id, payload.preferredLang)
      }
      // An absent/invalid preferredLang is not an error — `resolveLang` falls back to the tenant default at notify time; there is nothing to persist.
    })
  }

  async handleLeaveApproved(tx: Queryable, eventId: string, payload: LeaveApprovedPayload): Promise<void> {
    await idempotent(tx, 'notify', eventId, () => this.notifyLeaveApproved(tx, payload))
  }

  async handleClaimApprovedForPayroll(tx: Queryable, eventId: string, payload: ClaimApprovedForPayrollPayload): Promise<void> {
    await idempotent(tx, 'notify', eventId, () => this.notifyClaimApproved(tx, payload))
  }

  async handlePayslipIssued(tx: Queryable, eventId: string, payload: PayslipIssuedPayload): Promise<void> {
    await idempotent(tx, 'notify', eventId, () => this.notifyPayslipIssued(tx, payload))
  }

  /** `GET /notifications?unread=true` — `recipientUserId` must be the AUTHENTICATED caller's own id (self-scoped); the controller never accepts it from the request. */
  async listNotifications(recipientUserId: string, unreadOnly: boolean): Promise<NotificationRow[]> {
    return this.repo.listByRecipient(recipientUserId, unreadOnly)
  }

  /** `POST /notifications/:id/read` — self-scoped by the repository's `WHERE recipient_user_id = $2`; throws `NotificationNotFound` for both "no such id" and "not yours", indistinguishably. */
  async markRead(tx: Queryable, id: string, recipientUserId: string): Promise<NotificationRow> {
    const row = await this.repo.markRead(tx, id, recipientUserId)
    if (!row) throw new NotificationNotFound(id)
    return row
  }

  private async notifyLeaveApproved(tx: Queryable, payload: LeaveApprovedPayload): Promise<void> {
    const lang = await this.resolveLang(payload.employeeId)
    const { template, effectiveLang } = this.templates.load('leave.approved', lang)
    const sortedDates = [...payload.dates].sort()
    const start = sortedDates[0]
    const end = sortedDates[sortedDates.length - 1]
    const rendered = this.templates.render(template, {
      leaveTypeCode: payload.leaveTypeCode,
      days: String(payload.days),
      startDate: start ? formatDate(start, effectiveLang) : '',
      endDate: end ? formatDate(end, effectiveLang) : '',
      payMode: payload.payMode,
    })
    await this.deliver(tx, payload.employeeId, 'leave.approved', effectiveLang, rendered)
  }

  private async notifyClaimApproved(tx: Queryable, payload: ClaimApprovedForPayrollPayload): Promise<void> {
    const lang = await this.resolveLang(payload.employeeId)
    const { template, effectiveLang } = this.templates.load('claim.approved_for_payroll', lang)
    const rendered = this.templates.render(template, {
      claimType: payload.claimType,
      amount: formatTHB(thbToSatang(payload.amountThb), effectiveLang),
    })
    await this.deliver(tx, payload.employeeId, 'claim.approved_for_payroll', effectiveLang, rendered)
  }

  private async notifyPayslipIssued(tx: Queryable, payload: PayslipIssuedPayload): Promise<void> {
    const lang = await this.resolveLang(payload.employeeId)
    const { template, effectiveLang } = this.templates.load('payslip.issued', lang)
    const rendered = this.templates.render(template, { payslipId: payload.payslipId })
    await this.deliver(tx, payload.employeeId, 'payslip.issued', effectiveLang, rendered)
  }

  /** No known preference falls back to the TENANT default (constructor-injected), never to English-by-accident (Task 11 brief). */
  private async resolveLang(recipientUserId: string): Promise<Locale> {
    const pref = await this.repo.getRecipientPref(recipientUserId)
    return pref ?? this.tenantDefaultLang
  }

  private async deliver(
    tx: Queryable,
    recipientUserId: string,
    kind: string,
    lang: Locale,
    rendered: { subject: string; body: string },
  ): Promise<void> {
    const notification = await this.repo.insertNotification(tx, {
      recipientUserId,
      kind,
      lang,
      subject: rendered.subject,
      body: rendered.body,
    })

    // The in-app notification IS this row — writing it is the whole
    // "delivery", so it cannot itself fail the way an outbound SMTP call
    // can. Recorded as its own `delivery` row anyway (status always
    // `sent`) so `notify.delivery` is a complete log of every channel this
    // notification went out on, not just the ones that can fail.
    await this.repo.insertDelivery(tx, {
      notificationId: notification.id,
      channel: 'in_app',
      status: 'sent',
      attempts: 1,
      lastError: null,
      sent: true,
    })

    try {
      await this.emailTransport.send({
        to: placeholderEmailAddress(recipientUserId),
        subject: rendered.subject,
        body: rendered.body,
      })
      await this.repo.insertDelivery(tx, {
        notificationId: notification.id,
        channel: 'email',
        status: 'sent',
        attempts: 1,
        lastError: null,
        sent: true,
      })
    } catch (err) {
      // Caught, not rethrown: an SMTP failure must mark this one delivery
      // `failed` and stop there — it must NOT roll back this transaction
      // (which would also undo the in-app notification and the
      // `processed_events` row, causing the whole event to be redelivered
      // and every OTHER recipient in the batch to be re-notified a second
      // time) and it must NOT retry here either (Task 11 brief).
      const message = err instanceof Error ? err.message : String(err)
      await this.repo.insertDelivery(tx, {
        notificationId: notification.id,
        channel: 'email',
        status: 'failed',
        attempts: 1,
        lastError: message,
        sent: false,
      })
    }
  }
}

import type { Locale, Queryable } from '@gadong/kernel'

export type Channel = 'in_app' | 'email'
export type DeliveryStatus = 'sent' | 'failed'

export interface NotificationRow {
  id: string
  recipientUserId: string
  kind: string
  lang: Locale
  subject: string
  body: string
  readAt: string | null
  createdAt: string
}

export interface NewNotification {
  recipientUserId: string
  kind: string
  lang: Locale
  subject: string
  body: string
}

export interface DeliveryRow {
  id: string
  notificationId: string
  channel: Channel
  status: DeliveryStatus
  attempts: number
  lastError: string | null
  sentAt: string | null
}

export interface NewDelivery {
  notificationId: string
  channel: Channel
  status: DeliveryStatus
  attempts: number
  lastError: string | null
  /** Whether to stamp `sent_at = now()` — false leaves it NULL (a failed attempt was never sent). */
  sent: boolean
}

const NOTIFICATION_COLUMNS = 'id, recipient_user_id, kind, lang, subject, body, read_at, created_at'
const DELIVERY_COLUMNS = 'id, notification_id, channel, status, attempts, last_error, sent_at'

function isLocale(v: unknown): v is Locale {
  return v === 'th' || v === 'en' || v === 'zh'
}

function isChannel(v: unknown): v is Channel {
  return v === 'in_app' || v === 'email'
}

function isDeliveryStatus(v: unknown): v is DeliveryStatus {
  return v === 'sent' || v === 'failed'
}

function toIsoString(v: unknown): string {
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'string') return v
  throw new Error(`NotifyRepository: unexpected timestamp value ${JSON.stringify(v)}`)
}

function toIsoStringOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : toIsoString(v)
}

function mapNotification(row: Record<string, unknown>): NotificationRow {
  const lang = row['lang']
  if (!isLocale(lang)) throw new Error(`NotifyRepository: unexpected lang value ${JSON.stringify(lang)}`)
  return {
    id: String(row['id']),
    recipientUserId: String(row['recipient_user_id']),
    kind: String(row['kind']),
    lang,
    subject: String(row['subject']),
    body: String(row['body']),
    readAt: toIsoStringOrNull(row['read_at']),
    createdAt: toIsoString(row['created_at']),
  }
}

function mapDelivery(row: Record<string, unknown>): DeliveryRow {
  const channel = row['channel']
  const status = row['status']
  if (!isChannel(channel)) throw new Error(`NotifyRepository: unexpected channel value ${JSON.stringify(channel)}`)
  if (!isDeliveryStatus(status)) throw new Error(`NotifyRepository: unexpected status value ${JSON.stringify(status)}`)
  const attempts = row['attempts']
  return {
    id: String(row['id']),
    notificationId: String(row['notification_id']),
    channel,
    status,
    attempts: typeof attempts === 'number' ? attempts : Number(attempts),
    lastError: row['last_error'] === null || row['last_error'] === undefined ? null : String(row['last_error']),
    sentAt: toIsoStringOrNull(row['sent_at']),
  }
}

/**
 * SQL only — no business logic (language resolution, template rendering,
 * delivery orchestration) lives here; that is `notify.service.ts`'s job
 * (matching `services/svc-config`'s `repository`/`service` split).
 *
 * Read methods take the service's pool (`this.db`); write methods take the
 * CALLER's transaction handle `tx` — the same contract `writeOutbox`/
 * `idempotent` use, so a notification, its delivery rows, and the
 * `processed_events` row for the event that produced them all commit or
 * roll back together (kernel `withTransaction`).
 */
export class NotifyRepository {
  constructor(private readonly db: Queryable) {}

  async insertNotification(tx: Queryable, row: NewNotification): Promise<NotificationRow> {
    const { rows } = await tx.query(
      `INSERT INTO notify.notification (recipient_user_id, kind, lang, subject, body)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${NOTIFICATION_COLUMNS}`,
      [row.recipientUserId, row.kind, row.lang, row.subject, row.body],
    )
    const inserted: Record<string, unknown> | undefined = rows[0]
    if (!inserted) throw new Error('NotifyRepository.insertNotification: INSERT ... RETURNING produced no row')
    return mapNotification(inserted)
  }

  async insertDelivery(tx: Queryable, row: NewDelivery): Promise<DeliveryRow> {
    const { rows } = await tx.query(
      `INSERT INTO notify.delivery (notification_id, channel, status, attempts, last_error, sent_at)
       VALUES ($1, $2, $3, $4, $5, CASE WHEN $6 THEN now() ELSE NULL END)
       RETURNING ${DELIVERY_COLUMNS}`,
      [row.notificationId, row.channel, row.status, row.attempts, row.lastError, row.sent],
    )
    const inserted: Record<string, unknown> | undefined = rows[0]
    if (!inserted) throw new Error('NotifyRepository.insertDelivery: INSERT ... RETURNING produced no row')
    return mapDelivery(inserted)
  }

  /** `GET /notifications?unread=true` — self-scoped by construction: the caller always passes the AUTHENTICATED caller's own `userId`, never a value taken from the request body/query (`notify.controller.ts`). */
  async listByRecipient(recipientUserId: string, unreadOnly: boolean): Promise<NotificationRow[]> {
    const { rows } = await this.db.query(
      unreadOnly
        ? `SELECT ${NOTIFICATION_COLUMNS} FROM notify.notification WHERE recipient_user_id = $1 AND read_at IS NULL ORDER BY created_at DESC`
        : `SELECT ${NOTIFICATION_COLUMNS} FROM notify.notification WHERE recipient_user_id = $1 ORDER BY created_at DESC`,
      [recipientUserId],
    )
    return rows.map(mapNotification)
  }

  /**
   * `POST /notifications/:id/read` — self-scoped: the `WHERE` clause requires
   * `recipient_user_id = $2` (the authenticated caller), so a notification
   * belonging to someone else returns `null` exactly like a non-existent id
   * — the service turns both into the same 404, never a 403 that would
   * confirm to a caller that a specific other user's notification exists.
   * `COALESCE(read_at, now())` makes marking an already-read notification
   * read again a true no-op (same `read_at`), not a second timestamp.
   */
  async markRead(tx: Queryable, id: string, recipientUserId: string): Promise<NotificationRow | null> {
    const { rows } = await tx.query(
      `UPDATE notify.notification SET read_at = COALESCE(read_at, now())
       WHERE id = $1 AND recipient_user_id = $2
       RETURNING ${NOTIFICATION_COLUMNS}`,
      [id, recipientUserId],
    )
    const row = rows[0]
    return row !== undefined ? mapNotification(row) : null
  }

  /** Upserts this service's local read model of `employee.created`'s `preferredLang` — see the migration's file-header comment for why this table exists. */
  async upsertRecipientPref(tx: Queryable, userId: string, lang: Locale): Promise<void> {
    await tx.query(
      `INSERT INTO notify.recipient_pref (user_id, lang, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (user_id) DO UPDATE SET lang = EXCLUDED.lang, updated_at = now()`,
      [userId, lang],
    )
  }

  /** `null` means "no known preference" — the service falls back to the tenant default, never to English-by-accident (Task 11 brief). */
  async getRecipientPref(userId: string): Promise<Locale | null> {
    const { rows } = await this.db.query('SELECT lang FROM notify.recipient_pref WHERE user_id = $1', [userId])
    const row = rows[0]
    if (row === undefined) return null
    const lang = row['lang']
    return isLocale(lang) ? lang : null
  }
}

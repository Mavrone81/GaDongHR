import { randomUUID } from 'node:crypto'
import type { Queryable } from '@gadong/kernel'

/**
 * A tiny in-memory stand-in for Postgres, scoped to the `notify` schema —
 * the same reason and the same shape as `services/svc-config`'s
 * `testing/fake-db.ts` and `@gadong/kernel`'s `outbox/testing/fake-db.ts`:
 * there is no Postgres in this environment (Task 11 brief constraints), so
 * the repository/service layers are proven against a fake instead.
 * `migrations/1754200000000_notify-schema.js` is the source of truth for
 * the real schema; Task 13b re-proves this suite against real Postgres.
 */

export interface StoredNotificationRow {
  id: string
  recipient_user_id: string
  kind: string
  lang: string
  subject: string
  body: string
  read_at: Date | null
  created_at: Date
}

export interface StoredDeliveryRow {
  id: string
  notification_id: string
  channel: string
  status: string
  attempts: number
  last_error: string | null
  sent_at: Date | null
}

export class FakeNotifyDb {
  private readonly notifications = new Map<string, StoredNotificationRow>()
  private readonly deliveries = new Map<string, StoredDeliveryRow>()
  private readonly recipientPrefs = new Map<string, string>()
  private readonly processedEvents = new Set<string>()

  connect(): FakeNotifyConnection {
    return new FakeNotifyConnection(this)
  }

  /** A `Queryable` that runs every statement outside a transaction (autocommit) — enough for the repository's read-only methods, mirroring `FakeConfigDb.asPool()`. */
  asPool(): Queryable {
    const conn = this.connect()
    return { query: (sql: string, params?: unknown[]) => conn.query(sql, params) }
  }

  debugNotifications(): StoredNotificationRow[] {
    return [...this.notifications.values()]
  }

  debugDeliveries(): StoredDeliveryRow[] {
    return [...this.deliveries.values()]
  }

  debugRecipientPref(userId: string): string | null {
    return this.recipientPrefs.get(userId) ?? null
  }

  // --- internals used only by FakeNotifyConnection ---

  _allNotifications(): StoredNotificationRow[] {
    return [...this.notifications.values()]
  }

  _insertNotification(row: StoredNotificationRow): void {
    this.notifications.set(row.id, row)
  }

  _updateNotification(row: StoredNotificationRow): void {
    this.notifications.set(row.id, row)
  }

  _insertDelivery(row: StoredDeliveryRow): void {
    this.deliveries.set(row.id, row)
  }

  _getRecipientPref(userId: string): string | undefined {
    return this.recipientPrefs.get(userId)
  }

  _setRecipientPref(userId: string, lang: string): void {
    this.recipientPrefs.set(userId, lang)
  }

  _processedEventExists(schema: string, eventId: string): boolean {
    return this.processedEvents.has(`${schema}:${eventId}`)
  }

  _insertProcessedEvent(schema: string, eventId: string): void {
    this.processedEvents.add(`${schema}:${eventId}`)
  }
}

/** One session/connection. Mirrors `FakeConfigConnection`: writes made in a transaction are staged locally and only join the committed store on COMMIT. */
export class FakeNotifyConnection implements Queryable {
  private inTx = false
  private pendingNotificationInserts: StoredNotificationRow[] = []
  private pendingNotificationUpdates: StoredNotificationRow[] = []
  private pendingDeliveryInserts: StoredDeliveryRow[] = []
  private pendingRecipientPrefs: Array<{ userId: string; lang: string }> = []
  private pendingProcessedEvents: Array<{ schema: string; eventId: string }> = []

  constructor(private readonly db: FakeNotifyDb) {}

  /** No-op — present so kernel's `withTransaction`/`withConnection` (which call `client.release()`) can drive this fake directly, the same as a real `pg.PoolClient`. */
  release(_err?: Error): void {
    void _err
  }

  async query(sql: string, params: unknown[] = []): Promise<{ rows: Array<Record<string, unknown>> }> {
    const s = sql.trim()

    if (/^BEGIN\b/i.test(s)) {
      this.inTx = true
      this.pendingNotificationInserts = []
      this.pendingNotificationUpdates = []
      this.pendingDeliveryInserts = []
      this.pendingRecipientPrefs = []
      this.pendingProcessedEvents = []
      return { rows: [] }
    }

    if (/^COMMIT\b/i.test(s)) {
      for (const row of this.pendingNotificationInserts) this.db._insertNotification(row)
      for (const row of this.pendingNotificationUpdates) this.db._updateNotification(row)
      for (const row of this.pendingDeliveryInserts) this.db._insertDelivery(row)
      for (const { userId, lang } of this.pendingRecipientPrefs) this.db._setRecipientPref(userId, lang)
      for (const { schema, eventId } of this.pendingProcessedEvents) this.db._insertProcessedEvent(schema, eventId)
      this.inTx = false
      return { rows: [] }
    }

    if (/^ROLLBACK\b/i.test(s)) {
      this.pendingNotificationInserts = []
      this.pendingNotificationUpdates = []
      this.pendingDeliveryInserts = []
      this.pendingRecipientPrefs = []
      this.pendingProcessedEvents = []
      this.inTx = false
      return { rows: [] }
    }

    if (/^INSERT INTO\s+notify\.notification\b/i.test(s)) {
      return { rows: [toReturnedNotification(this.insertNotification(params))] }
    }

    if (/^INSERT INTO\s+notify\.delivery\b/i.test(s)) {
      return { rows: [toReturnedDelivery(this.insertDelivery(params))] }
    }

    if (/^UPDATE\s+notify\.notification\b/i.test(s)) {
      const [id, recipientUserId] = params as [string, string]
      const visible = this.visibleNotifications()
      const current = [...visible].reverse().find((r) => r.id === id && r.recipient_user_id === recipientUserId)
      if (!current) return { rows: [] }
      const updated: StoredNotificationRow = { ...current, read_at: current.read_at ?? new Date() }
      if (this.inTx) this.pendingNotificationUpdates.push(updated)
      else this.db._updateNotification(updated)
      return { rows: [toReturnedNotification(updated)] }
    }

    if (/^SELECT[\s\S]*FROM\s+notify\.notification\b/i.test(s)) {
      const [recipientUserId] = params as [string]
      let matches = this.visibleNotifications().filter((r) => r.recipient_user_id === recipientUserId)
      if (/read_at IS NULL/i.test(s)) matches = matches.filter((r) => r.read_at === null)
      matches = matches.sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
      return { rows: matches.map(toReturnedNotification) }
    }

    if (/^INSERT INTO\s+notify\.recipient_pref\b/i.test(s)) {
      const [userId, lang] = params as [string, string]
      if (this.inTx) this.pendingRecipientPrefs.push({ userId, lang })
      else this.db._setRecipientPref(userId, lang)
      return { rows: [] }
    }

    if (/^SELECT\s+lang\s+FROM\s+notify\.recipient_pref\b/i.test(s)) {
      const [userId] = params as [string]
      const pending = [...this.pendingRecipientPrefs].reverse().find((p) => p.userId === userId)
      const lang = pending?.lang ?? this.db._getRecipientPref(userId)
      return { rows: lang === undefined ? [] : [{ lang }] }
    }

    if (/^INSERT INTO\s+\S*processed_events\b/i.test(s)) {
      const schemaMatch = /INSERT INTO\s+(\S+)\.processed_events/i.exec(s)
      const schema = schemaMatch?.[1] ?? 'notify'
      const [eventId] = params as [string]
      const alreadyCommitted = this.db._processedEventExists(schema, eventId)
      const alreadyPendingHere = this.pendingProcessedEvents.some((p) => p.schema === schema && p.eventId === eventId)
      if (alreadyCommitted || alreadyPendingHere) return { rows: [] }
      if (this.inTx) this.pendingProcessedEvents.push({ schema, eventId })
      else this.db._insertProcessedEvent(schema, eventId)
      return { rows: [{ event_id: eventId }] }
    }

    if (/^SELECT 1\b/i.test(s)) {
      return { rows: [{ '?column?': 1 }] }
    }

    throw new Error(`FakeNotifyDb: unrecognised query: ${s}`)
  }

  private visibleNotifications(): StoredNotificationRow[] {
    const byId = new Map<string, StoredNotificationRow>()
    for (const r of this.db._allNotifications()) byId.set(r.id, r)
    for (const r of this.pendingNotificationInserts) byId.set(r.id, r)
    for (const r of this.pendingNotificationUpdates) byId.set(r.id, r)
    return [...byId.values()]
  }

  private insertNotification(params: unknown[]): StoredNotificationRow {
    const [recipientUserId, kind, lang, subject, body] = params as [string, string, string, string, string]
    const row: StoredNotificationRow = {
      id: randomUUID(),
      recipient_user_id: recipientUserId,
      kind,
      lang,
      subject,
      body,
      read_at: null,
      created_at: new Date(),
    }
    if (this.inTx) this.pendingNotificationInserts.push(row)
    else this.db._insertNotification(row)
    return row
  }

  private insertDelivery(params: unknown[]): StoredDeliveryRow {
    const [notificationId, channel, status, attempts, lastError, sent] = params as [
      string,
      string,
      string,
      number,
      string | null,
      boolean,
    ]
    const row: StoredDeliveryRow = {
      id: randomUUID(),
      notification_id: notificationId,
      channel,
      status,
      attempts,
      last_error: lastError,
      sent_at: sent ? new Date() : null,
    }
    if (this.inTx) this.pendingDeliveryInserts.push(row)
    else this.db._insertDelivery(row)
    return row
  }
}

function toReturnedNotification(r: StoredNotificationRow): Record<string, unknown> {
  return {
    id: r.id,
    recipient_user_id: r.recipient_user_id,
    kind: r.kind,
    lang: r.lang,
    subject: r.subject,
    body: r.body,
    read_at: r.read_at,
    created_at: r.created_at,
  }
}

function toReturnedDelivery(r: StoredDeliveryRow): Record<string, unknown> {
  return {
    id: r.id,
    notification_id: r.notification_id,
    channel: r.channel,
    status: r.status,
    attempts: r.attempts,
    last_error: r.last_error,
    sent_at: r.sent_at,
  }
}

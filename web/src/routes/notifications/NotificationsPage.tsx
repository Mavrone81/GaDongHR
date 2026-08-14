import { useCallback, useEffect, useState } from 'react'
import { useI18n } from '../../i18n/I18nContext'
import { useHasPermission } from '../../auth/permissions'
import { useSvcNotify } from '../../api/svcNotify'
import type { NotificationRow } from '../../api/svcNotify'
import { Eyebrow } from '../../components/Eyebrow'
import { Button } from '../../components/Button'
import { DateText } from '../../components/DateText'
import '../../components/page.css'
import './notifications.css'

function NotificationItem({
  notification,
  canMarkRead,
  onMarkRead,
}: {
  notification: NotificationRow
  canMarkRead: boolean
  onMarkRead: (id: string) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const isUnread = notification.readAt === null

  return (
    <li className={isUnread ? 'notification-row notification-row--unread' : 'notification-row'}>
      <div className="notification-row__header">
        <span className="notification-row__subject">{notification.subject}</span>
        {isUnread && <span className="notification-row__badge">{t('notifications.unreadBadge')}</span>}
      </div>
      <p className="notification-row__body">{notification.body}</p>
      <div className="notification-row__footer">
        <DateText iso={notification.createdAt} />
        {isUnread && canMarkRead && (
          <Button variant="quiet" onClick={() => onMarkRead(notification.id)}>
            {t('notifications.markRead.cta')}
          </Button>
        )}
      </div>
    </li>
  )
}

/**
 * The most-visited of the four screens (task brief: "broadest permission
 * — keep it fast and plain"). `GET /notifications`/`POST
 * /notifications/:id/read` (`services/svc-notify/src/notify.controller.ts`)
 * are both self-scoped server-side by the AUTHENTICATED caller's own id —
 * this screen never sends a user id, matching that contract. Mark-read is
 * gated by `notify.notification.update` (`useHasPermission`, same pattern
 * `StatutoryRulesPage.tsx`'s Approve button uses) — `auditor-readonly`
 * holds `notify.notification.read` but not `.update` (Security doc §4.2:
 * "Explicitly denied: any write"), so that role sees its inbox with no
 * Mark-read button rather than one that would 403.
 */
export function NotificationsPage(): React.JSX.Element {
  const { t } = useI18n()
  const svcNotify = useSvcNotify()
  const canMarkRead = useHasPermission('notify.notification.update')
  const [unreadOnly, setUnreadOnly] = useState(false)
  const [notifications, setNotifications] = useState<NotificationRow[]>([])
  const [loading, setLoading] = useState(true)

  const reload = useCallback(() => {
    setLoading(true)
    svcNotify
      .list(unreadOnly)
      .then(setNotifications)
      .finally(() => setLoading(false))
  }, [svcNotify, unreadOnly])

  useEffect(() => {
    reload()
  }, [reload])

  const handleMarkRead = useCallback(
    (id: string) => {
      svcNotify.markRead(id).then(() => reload())
    },
    [svcNotify, reload],
  )

  return (
    <section className="page">
      <header className="page__header">
        <Eyebrow>{t('shell.brand')}</Eyebrow>
        <h1 className="page__title">{t('notifications.title')}</h1>
      </header>

      <div className="notifications-filter" role="group">
        <Button variant="quiet" aria-pressed={!unreadOnly} onClick={() => setUnreadOnly(false)}>
          {t('notifications.filter.all')}
        </Button>
        <Button variant="quiet" aria-pressed={unreadOnly} onClick={() => setUnreadOnly(true)}>
          {t('notifications.filter.unreadOnly')}
        </Button>
      </div>

      {loading && <p>{t('common.loading')}</p>}
      {!loading && notifications.length === 0 && <p className="empty-state">{t('notifications.emptyState')}</p>}

      <ul className="notifications-list">
        {notifications.map((notification) => (
          <NotificationItem
            key={notification.id}
            notification={notification}
            canMarkRead={canMarkRead}
            onMarkRead={handleMarkRead}
          />
        ))}
      </ul>
    </section>
  )
}

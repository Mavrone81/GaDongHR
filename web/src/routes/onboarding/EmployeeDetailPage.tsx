import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useI18n } from '../../i18n/I18nContext'
import { useAuth } from '../../auth/AuthContext'
import { useHasPermission } from '../../auth/permissions'
import { useSvcOnboarding } from '../../api/svcOnboarding'
import type { ChecklistTask, EmployeeProfile } from '../../api/svcOnboarding'
import { ApiError } from '../../api/httpClient'
import type { ApiErrorEnvelope } from '../../api/httpClient'
import { Eyebrow } from '../../components/Eyebrow'
import { Button } from '../../components/Button'
import { Field } from '../../components/Field'
import { DateText } from '../../components/DateText'
import { ConsentPanel } from './ConsentPanel'
import '../../components/page.css'
import './onboarding.css'

/**
 * One employee, and the two things UAT pack U2 turns on: consent capture
 * (with biometric held separately, and a refusal path that must work) and
 * the onboarding checklist, where the SSO D+30 task has to be visible.
 *
 * The profile shown here is the NON-sensitive projection —
 * `GET /employees/:id`. National ID, bank account and the rest are S3/S2
 * and require a separate audited, purpose-carrying call that this screen
 * does not make: nobody needs a national ID to check whether an
 * onboarding checklist is complete, and fetching one to render a page
 * header would put an unjustified purpose into the audit chain on every
 * page view.
 */
export function EmployeeDetailPage(): React.JSX.Element {
  const { t } = useI18n()
  const { id = '' } = useParams<{ id: string }>()
  const { currentUser } = useAuth()
  const onboarding = useSvcOnboarding()
  const canManage = useHasPermission('onboarding.manage')
  const [profile, setProfile] = useState<EmployeeProfile | null>(null)
  const [tasks, setTasks] = useState<ChecklistTask[]>([])
  const [loading, setLoading] = useState(true)
  const [envelope, setEnvelope] = useState<ApiErrorEnvelope | null>(null)
  const [completing, setCompleting] = useState<string | null>(null)

  const reload = useCallback(() => {
    if (!id) return
    setLoading(true)
    setEnvelope(null)
    Promise.all([onboarding.getEmployee(id), canManage ? onboarding.getChecklist(id) : Promise.resolve([])])
      .then(([p, ts]) => {
        setProfile(p)
        setTasks(ts)
      })
      .catch((err: unknown) => {
        setProfile(null)
        setEnvelope(err instanceof ApiError && err.envelope ? err.envelope : null)
      })
      .finally(() => setLoading(false))
  }, [id, onboarding, canManage])

  useEffect(() => {
    reload()
  }, [reload])

  const handleComplete = useCallback(
    (taskId: string) => {
      if (!currentUser) return
      setCompleting(taskId)
      setEnvelope(null)
      onboarding
        .completeTask(taskId, currentUser.id)
        .then(() => reload())
        .catch((err: unknown) => {
          setEnvelope(err instanceof ApiError && err.envelope ? err.envelope : null)
        })
        .finally(() => setCompleting(null))
    },
    [currentUser, onboarding, reload],
  )

  return (
    <section className="page page--wide">
      <header className="page__header">
        <Eyebrow>{t('shell.brand')}</Eyebrow>
        <h1 className="page__title">{profile ? `${profile.firstNameEn} ${profile.lastNameEn}` : t('onboarding.detail.title')}</h1>
        <p className="onboarding-back">
          <Link to="/onboarding/employees">{t('onboarding.detail.backToList')}</Link>
        </p>
      </header>

      {envelope && <p className="onboarding-error">{t(envelope.message_i18n_key)}</p>}
      {loading && <p>{t('common.loading')}</p>}

      {profile && (
        <>
          <div className="onboarding-profile">
            <Field label={t('onboarding.employees.column.empCode')}>
              <span className="raw-code">{profile.empCode}</span>
            </Field>
            <Field label={t('onboarding.detail.nameTh')}>{`${profile.firstNameTh} ${profile.lastNameTh}`}</Field>
            {profile.nameZh && <Field label={t('onboarding.detail.nameZh')}>{profile.nameZh}</Field>}
            <Field label={t('onboarding.employees.column.employmentType')}>{t(`onboarding.employmentType.${profile.employmentType}`)}</Field>
            <Field label={t('onboarding.employees.column.orgUnit')}>
              <span className="raw-code">{profile.orgUnitId}</span>
            </Field>
            <Field label={t('onboarding.employees.column.startDate')}>
              <DateText iso={profile.startDate} />
            </Field>
            <Field label={t('onboarding.employees.column.status')}>
              <span className="status-badge">{t(`onboarding.employees.status.${profile.status}`)}</span>
            </Field>
            <Field label={t('onboarding.hire.email')}>{profile.email}</Field>
            <Field label={t('onboarding.hire.phone')}>{profile.phone}</Field>
          </div>

          <ConsentPanel employeeId={profile.id} onChanged={reload} />

          {canManage && (
            <section className="onboarding-checklist">
              <h2 className="onboarding-section-title">{t('onboarding.checklist.title')}</h2>
              {tasks.length === 0 && <p className="empty-state">{t('onboarding.checklist.emptyState')}</p>}
              <ul className="onboarding-checklist__list">
                {tasks.map((task) => {
                  const done = task.completedAt !== null
                  return (
                    <li key={task.id} className={done ? 'checklist-row checklist-row--done' : 'checklist-row'}>
                      <span className="checklist-row__code raw-code">{task.taskCode}</span>
                      <span className="checklist-row__due">
                        {task.dueDate ? <DateText iso={task.dueDate} /> : t('onboarding.checklist.noDueDate')}
                      </span>
                      <span className="status-badge">
                        {done ? t('onboarding.checklist.done') : t('onboarding.checklist.open')}
                        {/* The escalation flag is the whole point of the D+30 SSO
                            task being visible: an overdue statutory registration
                            must be loud on the screen, not buried in a report. */}
                        {task.escalated && !done ? ` · ${t('onboarding.checklist.escalated')}` : ''}
                      </span>
                      {!done && (
                        <Button variant="quiet" onClick={() => handleComplete(task.id)} disabled={completing === task.id}>
                          {completing === task.id ? t('common.loading') : t('onboarding.checklist.complete')}
                        </Button>
                      )}
                    </li>
                  )
                })}
              </ul>
            </section>
          )}
        </>
      )}
    </section>
  )
}

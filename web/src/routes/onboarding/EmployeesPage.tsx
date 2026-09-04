import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useI18n } from '../../i18n/I18nContext'
import { useHasPermission } from '../../auth/permissions'
import { useSvcOnboarding } from '../../api/svcOnboarding'
import type { EmployeeStatus, EmployeeSummary } from '../../api/svcOnboarding'
import { ApiError } from '../../api/httpClient'
import type { ApiErrorEnvelope } from '../../api/httpClient'
import { Eyebrow } from '../../components/Eyebrow'
import { Button } from '../../components/Button'
import { Table, TableCell, TableHeaderCell } from '../../components/Table'
import { DateText } from '../../components/DateText'
import { HireForm } from './HireForm'
import '../../components/page.css'
import './onboarding.css'

const STATUSES: EmployeeStatus[] = ['probation', 'active', 'suspended', 'terminated']

/**
 * UAT pack U2 ("Onboard a hire") starts here. Until svc-onboarding was
 * served this screen could not exist: the service, its schema and its
 * logic had been built and tested since Phase 2 but were never wired into
 * docker-compose, so the whole M1 surface was unreachable from the
 * product.
 *
 * The list deliberately shows only `EmployeeSummary` fields — code, type,
 * org unit, start date, status. Names, national IDs, addresses and bank
 * details are S2/S3 and are NOT in the list payload at all: reading them
 * is an audited, purpose-carrying call per employee
 * (`GET /employees/:id/sensitive`), which is a thing you do deliberately
 * on one record, not something a list screen does forty times to render a
 * table. That is the PDPA data-minimisation rule showing through the UI
 * rather than being asserted in a document.
 */
export function EmployeesPage(): React.JSX.Element {
  const { t } = useI18n()
  const onboarding = useSvcOnboarding()
  const canCreate = useHasPermission('employee.create')
  const [employees, setEmployees] = useState<EmployeeSummary[]>([])
  const [status, setStatus] = useState<EmployeeStatus | ''>('')
  const [loading, setLoading] = useState(true)
  const [showHire, setShowHire] = useState(false)
  const [envelope, setEnvelope] = useState<ApiErrorEnvelope | null>(null)

  const reload = useCallback(() => {
    setLoading(true)
    setEnvelope(null)
    onboarding
      .listEmployees(status ? { status } : undefined)
      .then(setEmployees)
      .catch((err: unknown) => {
        setEmployees([])
        setEnvelope(err instanceof ApiError && err.envelope ? err.envelope : null)
      })
      .finally(() => setLoading(false))
  }, [onboarding, status])

  useEffect(() => {
    reload()
  }, [reload])

  return (
    <section className="page page--wide">
      <header className="page__header">
        <Eyebrow>{t('shell.brand')}</Eyebrow>
        <h1 className="page__title">{t('onboarding.employees.title')}</h1>
      </header>

      {canCreate && (
        <p>
          <Button variant="primary" onClick={() => setShowHire((v) => !v)}>
            {t('onboarding.hire.cta')}
          </Button>
        </p>
      )}

      {showHire && (
        <HireForm
          onHired={() => {
            setShowHire(false)
            reload()
          }}
          onCancel={() => setShowHire(false)}
        />
      )}

      <div className="onboarding-filter" role="group" aria-label={t('onboarding.employees.filterLabel')}>
        <Button variant="quiet" aria-pressed={status === ''} onClick={() => setStatus('')}>
          {t('onboarding.employees.filterAll')}
        </Button>
        {STATUSES.map((s) => (
          <Button key={s} variant="quiet" aria-pressed={status === s} onClick={() => setStatus(s)}>
            {t(`onboarding.employees.status.${s}`)}
          </Button>
        ))}
      </div>

      {envelope && <p className="onboarding-error">{t(envelope.message_i18n_key)}</p>}
      {loading && <p>{t('common.loading')}</p>}
      {!loading && !envelope && employees.length === 0 && <p className="empty-state">{t('onboarding.employees.emptyState')}</p>}

      {!loading && employees.length > 0 && (
        <div className="table-scroll">
          <Table caption={t('onboarding.employees.title')}>
            <thead>
              <tr>
                <TableHeaderCell>{t('onboarding.employees.column.empCode')}</TableHeaderCell>
                <TableHeaderCell>{t('onboarding.employees.column.employmentType')}</TableHeaderCell>
                <TableHeaderCell>{t('onboarding.employees.column.orgUnit')}</TableHeaderCell>
                <TableHeaderCell>{t('onboarding.employees.column.startDate')}</TableHeaderCell>
                <TableHeaderCell>{t('onboarding.employees.column.status')}</TableHeaderCell>
                <TableHeaderCell>{t('onboarding.employees.column.actions')}</TableHeaderCell>
              </tr>
            </thead>
            <tbody>
              {employees.map((e) => (
                <tr key={e.id}>
                  <TableCell className="raw-code">{e.empCode}</TableCell>
                  <TableCell>{t(`onboarding.employmentType.${e.employmentType}`)}</TableCell>
                  <TableCell className="raw-code">{e.orgUnitId}</TableCell>
                  <TableCell>
                    <DateText iso={e.startDate} />
                  </TableCell>
                  <TableCell>
                    <span className="status-badge">{t(`onboarding.employees.status.${e.status}`)}</span>
                  </TableCell>
                  <TableCell>
                    <Link to={`/onboarding/employees/${e.id}`}>{t('common.view')}</Link>
                  </TableCell>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      )}
    </section>
  )
}

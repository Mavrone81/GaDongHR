import { useCallback, useEffect, useState } from 'react'
import { useI18n } from '../../i18n/I18nContext'
import { useAuth } from '../../auth/AuthContext'
import { useHasPermission } from '../../auth/permissions'
import { useSvcConfig } from '../../api/svcConfig'
import type { StatutoryRuleRow } from '../../api/svcConfig'
import { ApiError } from '../../api/httpClient'
import type { ApiErrorEnvelope } from '../../api/httpClient'
import { Seal } from '../../components/Seal'
import { Eyebrow } from '../../components/Eyebrow'
import { Field } from '../../components/Field'
import { Button } from '../../components/Button'
import { Table, TableCell, TableHeaderCell } from '../../components/Table'
import { RuleValue } from './RuleValue'
import { FloorViolationNotice } from './FloorViolationNotice'
import { ProposeRuleForm } from './ProposeRuleForm'
import { DateText } from '../../components/DateText'
import './statutoryRules.css'

function AsOfDetail({ ruleKey }: { ruleKey: string }): React.JSX.Element {
  const { t } = useI18n()
  const svcConfig = useSvcConfig()
  const [on, setOn] = useState('')
  const [row, setRow] = useState<StatutoryRuleRow | null>(null)
  const [envelope, setEnvelope] = useState<ApiErrorEnvelope | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!on) {
      setRow(null)
      setEnvelope(null)
      return
    }
    let cancelled = false
    setLoading(true)
    svcConfig
      .getRule(ruleKey, on)
      .then((r) => {
        if (!cancelled) {
          setRow(r)
          setEnvelope(null)
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setRow(null)
        setEnvelope(err instanceof ApiError && err.envelope ? err.envelope : null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [on, ruleKey, svcConfig])

  return (
    <div className="rule-row__detail">
      <Field label={t('admin.statutoryRules.asOfLabel')} htmlFor={`as-of-${ruleKey}`}>
        <input id={`as-of-${ruleKey}`} type="date" value={on} onChange={(e) => setOn(e.target.value)} />
      </Field>
      {loading && <p>{t('common.loading')}</p>}
      {row && (
        <Table caption={t('admin.statutoryRules.asOfLabel')}>
          <thead>
            <tr>
              <TableHeaderCell numeric>{t('admin.statutoryRules.propose.value')}</TableHeaderCell>
              <TableHeaderCell>{t('admin.statutoryRules.propose.citation')}</TableHeaderCell>
              <TableHeaderCell>{t('admin.statutoryRules.propose.effectiveFrom')}</TableHeaderCell>
            </tr>
          </thead>
          <tbody>
            <tr>
              <TableCell numeric>
                <RuleValue value={row.value} />
              </TableCell>
              <TableCell>
                <Seal citation={row.citation} floor={row.statutoryFloor} ceiling={row.statutoryCeiling} />
              </TableCell>
              <TableCell>
                <DateText iso={row.effectiveFrom} />
              </TableCell>
            </tr>
          </tbody>
        </Table>
      )}
      {envelope && <FloorViolationNotice envelope={envelope} />}
    </div>
  )
}

/** Exported for direct testing (`StatutoryRulesPage.test.tsx`'s segregation-of-duties assertions) — otherwise only used internally by `StatutoryRulesPage` below. */
export function RuleRow({
  row,
  onApproved,
}: {
  row: StatutoryRuleRow
  onApproved: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const { currentUser } = useAuth()
  const svcConfig = useSvcConfig()
  const canApprove = useHasPermission('config.rule.approve')
  const isProposer = row.proposedBy !== null && row.proposedBy === currentUser?.id
  const [showAsOf, setShowAsOf] = useState(false)
  const [approving, setApproving] = useState(false)
  const [envelope, setEnvelope] = useState<ApiErrorEnvelope | null>(null)

  const handleApprove = useCallback(() => {
    if (!currentUser) return
    setApproving(true)
    setEnvelope(null)
    svcConfig
      .approveRule(row.id, currentUser.id)
      .then(() => onApproved())
      .catch((err: unknown) => {
        setEnvelope(err instanceof ApiError && err.envelope ? err.envelope : null)
      })
      .finally(() => setApproving(false))
  }, [currentUser, row.id, svcConfig, onApproved])

  return (
    <li className="rule-row">
      <div className="rule-row__key">{row.ruleKey}</div>
      <div className="rule-row__value">
        <RuleValue value={row.value} />
      </div>
      <div className="rule-row__citation">
        <Seal citation={row.citation} floor={row.statutoryFloor} ceiling={row.statutoryCeiling} />
      </div>
      <div className="rule-row__status">
        <span className="status-badge">{t(`admin.statutoryRules.status.${row.status}`)}</span>
        {row.status === 'draft' &&
          (canApprove && !isProposer ? (
            <Button variant="primary" onClick={handleApprove} disabled={approving}>
              {t('admin.statutoryRules.approve.cta')}
            </Button>
          ) : canApprove && isProposer ? (
            <p>{t('admin.statutoryRules.approve.selfProposed')}</p>
          ) : null)}
      </div>
      <div className="rule-row__detail">
        <Button variant="quiet" onClick={() => setShowAsOf((v) => !v)}>
          {t('common.view')}
        </Button>
        {showAsOf && <AsOfDetail ruleKey={row.ruleKey} />}
        {envelope && <FloorViolationNotice envelope={envelope} />}
      </div>
    </li>
  )
}

/**
 * The compliance showcase (`web/ui-coverage.json`'s `/admin/statutory-rules`
 * screen — `config.rule.read`, `config.rule.propose`, `config.rule.approve`,
 * `config.pack.import` all surface here). Every figure the law sets carries
 * its `Seal`; a proposal rejected below the statutory floor renders
 * `FloorViolationNotice` inline (the task's "entire compliance argument
 * made visible"); Approve is unreachable for the row's own proposer
 * (`RuleRow`'s `isProposer` check — mirrors the exact segregation-of-duties
 * rule `services/svc-config/src/rules.service.ts`'s `approve()` enforces
 * server-side with `sodViolation`), so this app never lets a user click
 * into a 409 they could not have predicted.
 */
export function StatutoryRulesPage(): React.JSX.Element {
  const { t } = useI18n()
  const { currentUser } = useAuth()
  const svcConfig = useSvcConfig()
  const canPropose = useHasPermission('config.rule.propose')
  const [rules, setRules] = useState<StatutoryRuleRow[]>([])
  const [loading, setLoading] = useState(true)
  const [showPropose, setShowPropose] = useState(false)

  const reload = useCallback(() => {
    setLoading(true)
    svcConfig
      .listRules()
      .then(setRules)
      .finally(() => setLoading(false))
  }, [svcConfig])

  useEffect(() => {
    reload()
  }, [reload])

  return (
    <section className="page page--wide">
      <header className="page__header">
        <Eyebrow>{t('shell.brand')}</Eyebrow>
        <h1 className="page__title">{t('admin.statutoryRules.title')}</h1>
      </header>

      {canPropose && (
        <p>
          <Button variant="primary" onClick={() => setShowPropose((v) => !v)}>
            {t('admin.statutoryRules.propose.cta')}
          </Button>
        </p>
      )}

      {showPropose && currentUser && (
        <ProposeRuleForm
          proposedBy={currentUser.id}
          onPropose={(input) => svcConfig.proposeRule(input)}
          onProposed={reload}
          onCancel={() => setShowPropose(false)}
        />
      )}

      {loading && <p>{t('common.loading')}</p>}

      {!loading && rules.length === 0 && <p className="empty-state">{t('admin.statutoryRules.emptyState')}</p>}

      {!loading && rules.length > 0 && (
        <div className="rules-list__head" aria-hidden="true">
          <span>{t('admin.statutoryRules.columns.rule')}</span>
          <span>{t('admin.statutoryRules.columns.value')}</span>
          <span>{t('admin.statutoryRules.columns.citation')}</span>
          <span>{t('admin.statutoryRules.columns.status')}</span>
        </div>
      )}

      <ul className="rules-list">
        {rules.map((row) => (
          <RuleRow key={row.id} row={row} onApproved={reload} />
        ))}
      </ul>
    </section>
  )
}

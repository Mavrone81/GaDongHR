import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { useI18n } from '../../i18n/I18nContext'
import { useSvcAudit, AUDIT_PAGE_SIZE } from '../../api/svcAudit'
import type { AuditEntryRow, VerifyResult } from '../../api/svcAudit'
import { Eyebrow } from '../../components/Eyebrow'
import { Field } from '../../components/Field'
import { Button } from '../../components/Button'
import { Table, TableCell, TableHeaderCell } from '../../components/Table'
import { DateText } from '../../components/DateText'
import '../../components/page.css'
import './audit.css'

interface AppliedFilters {
  entity?: string
  entityId?: string
  from?: string
  to?: string
}

function AuditEntryDetail({ entry }: { entry: AuditEntryRow }): React.JSX.Element {
  const { t } = useI18n()
  return (
    <div className="audit-entry__detail">
      <Field label={t('audit.detailPanel.prevEntryHash')}>
        <span className="numeric audit-hash">{entry.prevEntryHash}</span>
      </Field>
      <Field label={t('audit.detailPanel.entryHash')}>
        <span className="numeric audit-hash">{entry.entryHash}</span>
      </Field>
      <Field label={t('audit.detailPanel.beforeHash')}>
        <span className="numeric audit-hash">{entry.beforeHash ?? t('audit.detailPanel.none')}</span>
      </Field>
      <Field label={t('audit.detailPanel.afterHash')}>
        <span className="numeric audit-hash">{entry.afterHash ?? t('audit.detailPanel.none')}</span>
      </Field>
    </div>
  )
}

/** Exported for direct testing — otherwise only used internally by `AuditPage` below. */
export function AuditEntryLine({ entry }: { entry: AuditEntryRow }): React.JSX.Element {
  const { t } = useI18n()
  const [expanded, setExpanded] = useState(false)
  return (
    <>
      <tr>
        <TableCell>
          <DateText iso={entry.occurredAt} />
        </TableCell>
        <TableCell>{t('audit.table.actorLine', { actorId: entry.actorId, actorRole: entry.actorRole })}</TableCell>
        <TableCell>
          {/* `raw-code`: a real `audit.entry.action` code (e.g. `employee.update`), not
              translatable prose — see `e2e/assertions.ts`'s header for why this marker
              exists and what it does and does not exempt from the no-raw-key check. */}
          <span className="raw-code">{entry.action}</span>
        </TableCell>
        <TableCell>{t('audit.table.entityLine', { entity: entry.entity, entityId: entry.entityId })}</TableCell>
        <TableCell>{entry.purpose ?? t('audit.detailPanel.none')}</TableCell>
        <TableCell>
          <Button variant="quiet" onClick={() => setExpanded((v) => !v)}>
            {t('common.view')}
          </Button>
        </TableCell>
      </tr>
      {expanded && (
        <tr>
          <TableCell colSpan={6}>
            <AuditEntryDetail entry={entry} />
          </TableCell>
        </tr>
      )}
    </>
  )
}

/**
 * The chain-integrity affordance (`GET /verify`,
 * `services/svc-audit/src/entries.service.ts`'s `verify()` — walks the
 * whole chain from genesis and names every entry where the hash chain
 * fails to check out; see `chain.ts`'s header for the two independent
 * failure modes it distinguishes). DESIGN.md reserves `--seal` for
 * statutory citations only (`src/styles/noSealOutsideSeal.test.tsx`
 * enforces this mechanically), so this panel does NOT reuse `Seal` for a
 * verified chain — the weight here comes from `.audit-verify__result`'s
 * own ink/border treatment (`audit.css`), the same non-seal emphasis
 * `floor-violation` uses on the statutory-rules screen.
 */
export function VerifyPanel(): React.JSX.Element {
  const { t } = useI18n()
  const svcAudit = useSvcAudit()
  const [result, setResult] = useState<VerifyResult | null>(null)
  const [verifying, setVerifying] = useState(false)

  const handleVerify = useCallback(() => {
    setVerifying(true)
    svcAudit
      .verify()
      .then(setResult)
      .finally(() => setVerifying(false))
  }, [svcAudit])

  return (
    <div className="audit-verify">
      <Button variant="primary" onClick={handleVerify} disabled={verifying}>
        {verifying ? t('audit.verify.verifying') : t('audit.verify.cta')}
      </Button>
      {result && (
        <div
          className={
            result.valid
              ? 'audit-verify__result audit-verify__result--valid'
              : 'audit-verify__result audit-verify__result--invalid'
          }
        >
          <p>
            {result.valid
              ? t('audit.verify.valid', { count: result.entryCount })
              : t('audit.verify.invalid', { issueCount: result.issues.length, entryCount: result.entryCount })}
          </p>
          {result.issues.length > 0 && (
            <ul className="audit-verify__issues">
              {result.issues.map((issue) => (
                <li key={`${issue.entryId}-${issue.kind}`}>
                  <strong>{t('audit.verify.issueEntry', { kind: t(`audit.verify.issueKind.${issue.kind}`), entryId: issue.entryId })}</strong>
                  <p className="numeric audit-hash">{issue.message}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * The compliance showpiece (task brief: "austere, tabular, seal-red
 * reserved for integrity-verified moments") — DESIGN.md's "Official
 * Record" aesthetic exists for exactly this screen. Filters
 * entity/entityId/from/to hit `GET /entries` for real
 * (`services/svc-audit/src/entries.repository.ts`'s `EntryFilters` — the
 * only four the server accepts); the "quick filter" text field narrows by
 * actor/action CLIENT-SIDE over whatever page is already loaded, since
 * `/entries` has no actor/action query param at all — see `svcAudit.ts`'s
 * header for why that is not silently presented as a server-side filter.
 * Each row's hash-chain fields (`prevEntryHash`/`entryHash`/`beforeHash`/
 * `afterHash`) are already in the list response — no separate detail
 * fetch — and `VerifyPanel` above is the chain-integrity affordance
 * `GET /verify` exposes.
 */
export function AuditPage(): React.JSX.Element {
  const { t } = useI18n()
  const svcAudit = useSvcAudit()

  const [entityInput, setEntityInput] = useState('')
  const [entityIdInput, setEntityIdInput] = useState('')
  const [fromInput, setFromInput] = useState('')
  const [toInput, setToInput] = useState('')
  const [appliedFilters, setAppliedFilters] = useState<AppliedFilters>({})
  const [page, setPage] = useState(1)
  const [quickFilter, setQuickFilter] = useState('')

  const [entries, setEntries] = useState<AuditEntryRow[]>([])
  const [loading, setLoading] = useState(true)

  const reload = useCallback(() => {
    setLoading(true)
    svcAudit
      .listEntries({ ...appliedFilters, page })
      .then((res) => setEntries(res.entries))
      .finally(() => setLoading(false))
  }, [svcAudit, appliedFilters, page])

  useEffect(() => {
    reload()
  }, [reload])

  const handleApplyFilters = useCallback(
    (e: FormEvent) => {
      e.preventDefault()
      setPage(1)
      setAppliedFilters({
        entity: entityInput.trim() || undefined,
        entityId: entityIdInput.trim() || undefined,
        from: fromInput || undefined,
        to: toInput || undefined,
      })
    },
    [entityInput, entityIdInput, fromInput, toInput],
  )

  const visibleEntries = useMemo(() => {
    const needle = quickFilter.trim().toLowerCase()
    if (!needle) return entries
    return entries.filter(
      (entry) =>
        entry.actorId.toLowerCase().includes(needle) ||
        entry.actorRole.toLowerCase().includes(needle) ||
        entry.action.toLowerCase().includes(needle),
    )
  }, [entries, quickFilter])

  return (
    <section className="page">
      <header className="page__header">
        <Eyebrow>{t('shell.brand')}</Eyebrow>
        <h1 className="page__title">{t('audit.title')}</h1>
      </header>

      <form className="panel audit-filters" onSubmit={handleApplyFilters}>
        <Field label={t('audit.filters.entity')} htmlFor="audit-filter-entity">
          <input id="audit-filter-entity" value={entityInput} onChange={(e) => setEntityInput(e.target.value)} />
        </Field>
        <Field label={t('audit.filters.entityId')} htmlFor="audit-filter-entity-id">
          <input id="audit-filter-entity-id" value={entityIdInput} onChange={(e) => setEntityIdInput(e.target.value)} />
        </Field>
        <Field label={t('audit.filters.from')} htmlFor="audit-filter-from">
          <input id="audit-filter-from" type="date" value={fromInput} onChange={(e) => setFromInput(e.target.value)} />
        </Field>
        <Field label={t('audit.filters.to')} htmlFor="audit-filter-to">
          <input id="audit-filter-to" type="date" value={toInput} onChange={(e) => setToInput(e.target.value)} />
        </Field>
        <p className="panel__actions">
          <Button type="submit" variant="primary">
            {t('audit.filters.apply')}
          </Button>
        </p>
      </form>

      <Field label={t('audit.filters.quickFilter')} htmlFor="audit-quick-filter">
        <input id="audit-quick-filter" value={quickFilter} onChange={(e) => setQuickFilter(e.target.value)} />
      </Field>

      {loading && <p>{t('common.loading')}</p>}

      {!loading && visibleEntries.length === 0 && <p className="empty-state">{t('audit.emptyState')}</p>}

      {!loading && visibleEntries.length > 0 && (
        <Table caption={t('audit.title')}>
          <thead>
            <tr>
              <TableHeaderCell>{t('audit.table.occurredAt')}</TableHeaderCell>
              <TableHeaderCell>{t('audit.table.actor')}</TableHeaderCell>
              <TableHeaderCell>{t('audit.table.action')}</TableHeaderCell>
              <TableHeaderCell>{t('audit.table.entity')}</TableHeaderCell>
              <TableHeaderCell>{t('audit.table.purpose')}</TableHeaderCell>
              <TableHeaderCell>{t('audit.table.detail')}</TableHeaderCell>
            </tr>
          </thead>
          <tbody>
            {visibleEntries.map((entry) => (
              <AuditEntryLine key={entry.id} entry={entry} />
            ))}
          </tbody>
        </Table>
      )}

      <p className="audit-pagination">
        <Button variant="secondary" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>
          {t('audit.pagination.prev')}
        </Button>{' '}
        <span className="eyebrow">{t('audit.pagination.label', { page })}</span>{' '}
        <Button variant="secondary" onClick={() => setPage((p) => p + 1)} disabled={entries.length < AUDIT_PAGE_SIZE}>
          {t('audit.pagination.next')}
        </Button>
      </p>

      <VerifyPanel />
    </section>
  )
}

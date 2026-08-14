import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useI18n } from '../../i18n/I18nContext'
import { useHasPermission } from '../../auth/permissions'
import { useSvcDocs } from '../../api/svcDocs'
import type { DocLocale, DocumentMeta } from '../../api/svcDocs'
import { ApiError } from '../../api/httpClient'
import type { ApiErrorEnvelope } from '../../api/httpClient'
import { Eyebrow } from '../../components/Eyebrow'
import { Field } from '../../components/Field'
import { Button } from '../../components/Button'
import { DateText } from '../../components/DateText'
import '../../components/page.css'
import './documents.css'

const DOC_LOCALES: DocLocale[] = ['th', 'en', 'zh']

function base64ToBlob(base64: string): Blob {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: 'application/pdf' })
}

function downloadPdf(meta: DocumentMeta): void {
  const blob = base64ToBlob(meta.contentBase64)
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${meta.kind}-${meta.id}-${meta.lang}.pdf`
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

function ErrorNotice({ envelope }: { envelope: ApiErrorEnvelope }): React.JSX.Element {
  const { t } = useI18n()
  return <p className="documents-error">{t(envelope.message_i18n_key)}</p>
}

/**
 * The lookup + purpose-capture + download flow (task brief: "S3-read
 * purpose prompt ... build the purpose UI now either way, it's the correct
 * PDPA pattern"). `purpose` is captured and sent on every read regardless
 * of whether `GET /documents/:id` currently consumes it — see
 * `svcDocs.ts`'s header for exactly what the shipped controller does with
 * it today (nothing; the service hardcodes its own purpose string), and why
 * sending it anyway is still the right, forward-compatible default.
 */
function LookupPanel({ initialId, autoLookup = false }: { initialId: string; autoLookup?: boolean }): React.JSX.Element {
  const { t } = useI18n()
  const svcDocs = useSvcDocs()
  const [id, setId] = useState(initialId)
  const [purpose, setPurpose] = useState('')
  const [meta, setMeta] = useState<DocumentMeta | null>(null)
  const [envelope, setEnvelope] = useState<ApiErrorEnvelope | null>(null)
  const [loading, setLoading] = useState(false)

  const runLookup = useCallback(
    (lookupId: string, lookupPurpose: string) => {
      setLoading(true)
      setEnvelope(null)
      setMeta(null)
      svcDocs
        .getDocument(lookupId.trim(), lookupPurpose.trim() || undefined)
        .then((result) => setMeta(result))
        .catch((err: unknown) => {
          setEnvelope(err instanceof ApiError && err.envelope ? err.envelope : null)
        })
        .finally(() => setLoading(false))
    },
    [svcDocs],
  )

  const handleSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault()
      runLookup(id, purpose)
    },
    [runLookup, id, purpose],
  )

  // `GeneratePanel`'s "Look up this document" hands off a freshly-generated
  // id via `DocumentsPage`'s `key`-remount (see that component's header) —
  // when it does, retrieve it immediately rather than merely pre-filling
  // the field and waiting for a second click. Runs once, on mount only
  // (deliberately empty deps): this component is remounted fresh (new
  // `key`) for every hand-off, so "on mount" and "on hand-off" are the same
  // event here.
  useEffect(() => {
    if (autoLookup && initialId) runLookup(initialId, '')
  }, [])

  return (
    <form className="panel" onSubmit={handleSubmit} id="documents-lookup-form">
      <Eyebrow>{t('documents.lookup.title')}</Eyebrow>

      <Field label={t('documents.lookup.id')} htmlFor="documents-lookup-id">
        <input id="documents-lookup-id" value={id} onChange={(e) => setId(e.target.value)} required />
      </Field>

      <Field label={t('documents.lookup.purpose')} htmlFor="documents-lookup-purpose">
        <input id="documents-lookup-purpose" value={purpose} onChange={(e) => setPurpose(e.target.value)} />
      </Field>
      <p className="documents-hint">{t('documents.lookup.purposeHint')}</p>

      <p className="panel__actions">
        <Button type="submit" variant="primary" disabled={loading}>
          {loading ? t('common.loading') : t('documents.lookup.submit')}
        </Button>
      </p>

      {envelope && <ErrorNotice envelope={envelope} />}

      {meta && (
        <div className="documents-meta">
          <Field label={t('documents.meta.kind')}>{meta.kind}</Field>
          <Field label={t('documents.meta.entityType')}>{meta.entityType}</Field>
          <Field label={t('documents.meta.entityId')}>{meta.entityId}</Field>
          <Field label={t('documents.meta.lang')}>{meta.lang}</Field>
          <Field label={t('documents.meta.sha256')} numeric>
            <span className="documents-hash">{meta.sha256}</span>
          </Field>
          <Field label={t('documents.meta.createdAt')}>
            <DateText iso={meta.createdAt} />
          </Field>
          <p className="panel__actions">
            <Button type="button" variant="secondary" onClick={() => downloadPdf(meta)}>
              {t('documents.download.cta')}
            </Button>
          </p>
        </div>
      )}
    </form>
  )
}

/**
 * `POST /render` — gated separately from the page's own `document.read`
 * route guard, by `document.generate` (mirrors `StatutoryRulesPage.tsx`'s
 * Propose button, gated by `config.rule.propose` inside a page reachable
 * on `config.rule.read`). Only the caller-owned-HTML input path is exposed
 * — `RenderRequestBody`'s `mergeFields` path needs per-template field
 * knowledge (`services/svc-docs/src/templates/*`) this generic console has
 * no way to know; the business screens that actually generate contracts/
 * payslips (onboarding, payroll) already own that knowledge and call
 * `/render` directly. This panel exists so the read side above has
 * something real to look up in a fresh environment with no documents yet.
 */
function GeneratePanel({ onGenerated }: { onGenerated: (id: string) => void }): React.JSX.Element {
  const { t } = useI18n()
  const svcDocs = useSvcDocs()
  const [kind, setKind] = useState('')
  const [lang, setLang] = useState<DocLocale>('th')
  const [entityType, setEntityType] = useState('')
  const [entityId, setEntityId] = useState('')
  const [html, setHtml] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [envelope, setEnvelope] = useState<ApiErrorEnvelope | null>(null)
  const [generatedId, setGeneratedId] = useState<string | null>(null)

  const handleSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault()
      setSubmitting(true)
      setEnvelope(null)
      setGeneratedId(null)
      svcDocs
        .render({ kind, lang, entityType, entityId, html })
        .then((result) => setGeneratedId(result.id))
        .catch((err: unknown) => {
          setEnvelope(err instanceof ApiError && err.envelope ? err.envelope : null)
        })
        .finally(() => setSubmitting(false))
    },
    [svcDocs, kind, lang, entityType, entityId, html],
  )

  return (
    <form className="panel" onSubmit={handleSubmit}>
      <Eyebrow>{t('documents.generate.title')}</Eyebrow>

      <Field label={t('documents.generate.kind')} htmlFor="documents-generate-kind">
        <input id="documents-generate-kind" value={kind} onChange={(e) => setKind(e.target.value)} required />
      </Field>

      <Field label={t('documents.generate.lang')} htmlFor="documents-generate-lang">
        <select id="documents-generate-lang" value={lang} onChange={(e) => setLang(e.target.value as DocLocale)}>
          {DOC_LOCALES.map((l) => (
            <option key={l} value={l}>
              {t(`shell.locale.${l}`)}
            </option>
          ))}
        </select>
      </Field>

      <Field label={t('documents.generate.entityType')} htmlFor="documents-generate-entity-type">
        <input id="documents-generate-entity-type" value={entityType} onChange={(e) => setEntityType(e.target.value)} required />
      </Field>

      <Field label={t('documents.generate.entityId')} htmlFor="documents-generate-entity-id">
        <input id="documents-generate-entity-id" value={entityId} onChange={(e) => setEntityId(e.target.value)} required />
      </Field>

      <Field label={t('documents.generate.html')} htmlFor="documents-generate-html">
        <textarea id="documents-generate-html" value={html} onChange={(e) => setHtml(e.target.value)} required rows={6} />
      </Field>

      <p className="panel__actions">
        <Button type="submit" variant="primary" disabled={submitting}>
          {t('documents.generate.submit')}
        </Button>
      </p>

      {envelope && <ErrorNotice envelope={envelope} />}

      {generatedId && (
        <p>
          {t('documents.generate.success', { id: generatedId })}{' '}
          <Button type="button" variant="quiet" onClick={() => onGenerated(generatedId)}>
            {t('documents.generate.lookupNow')}
          </Button>
        </p>
      )}
    </form>
  )
}

/**
 * `svc-docs` has no route that lists documents at all — only `GET
 * /documents/:id` (one document, by id) and `POST /render` (generate a
 * new one). This screen is scoped to exactly that: a lookup-by-id +
 * purpose-capture + download flow, plus a generate panel that produces an
 * id the lookup panel can immediately look up — there is no browsable
 * list here because the API genuinely does not serve one (task brief:
 * "build the smaller honest screen and report the gap").
 */
export function DocumentsPage(): React.JSX.Element {
  const { t } = useI18n()
  const canGenerate = useHasPermission('document.generate')
  const [searchParams] = useSearchParams()
  const [lookupId, setLookupId] = useState(searchParams.get('id') ?? '')
  const [lookupKey, setLookupKey] = useState(0)
  const [autoLookup, setAutoLookup] = useState(false)

  const jumpToLookup = useCallback((id: string) => {
    setLookupId(id)
    setAutoLookup(true)
    setLookupKey((k) => k + 1)
  }, [])

  return (
    <section className="page">
      <header className="page__header">
        <Eyebrow>{t('shell.brand')}</Eyebrow>
        <h1 className="page__title">{t('documents.title')}</h1>
      </header>

      <LookupPanel key={lookupKey} initialId={lookupId} autoLookup={autoLookup} />

      {canGenerate && <GeneratePanel onGenerated={jumpToLookup} />}
    </section>
  )
}

import { useI18n } from '../../i18n/I18nContext'
import { Seal } from '../../components/Seal'
import type { ApiErrorEnvelope } from '../../api/httpClient'
import './statutoryRules.css'

interface FloorDetail {
  ruleKey?: unknown
  value?: unknown
  statutoryFloor?: unknown
  citation?: unknown
}
interface CeilingDetail {
  ruleKey?: unknown
  value?: unknown
  statutoryCeiling?: unknown
  citation?: unknown
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/**
 * The task brief's central UX moment: "When a proposal is rejected below
 * the statutory floor, show the citation and the floor. That single
 * interaction is the product's entire compliance argument made visible."
 * Renders `CFG-422` (`config.error.below_statutory_floor` /
 * `config.error.above_statutory_ceiling` — `services/svc-config/src/rules.service.ts`'s
 * `statutoryFloorViolation`/`statutoryCeilingViolation`) with the same
 * `Seal` used everywhere else a statutory figure appears, so a
 * rejection reads as "the law says no", not a generic form-validation
 * error.
 */
export function FloorViolationNotice({ envelope }: { envelope: ApiErrorEnvelope }): React.JSX.Element | null {
  const { t } = useI18n()
  const detail = envelope.details[0]

  if (envelope.code === 'CFG-422' && envelope.message_i18n_key === 'config.error.below_statutory_floor') {
    const d = isRecord(detail) ? (detail as FloorDetail) : {}
    const citation = typeof d.citation === 'string' ? d.citation : ''
    return (
      <div className="floor-violation">
        <p className="floor-violation__title">{t('admin.statutoryRules.floorViolation.title')}</p>
        <p>{t('admin.statutoryRules.floorViolation.body', { value: String(d.value ?? ''), floor: String(d.statutoryFloor ?? '') })}</p>
        <Seal citation={citation} floor={d.statutoryFloor} />
      </div>
    )
  }

  if (envelope.code === 'CFG-422' && envelope.message_i18n_key === 'config.error.above_statutory_ceiling') {
    const d = isRecord(detail) ? (detail as CeilingDetail) : {}
    const citation = typeof d.citation === 'string' ? d.citation : ''
    return (
      <div className="floor-violation">
        <p className="floor-violation__title">{t('admin.statutoryRules.ceilingViolation.title')}</p>
        <p>
          {t('admin.statutoryRules.ceilingViolation.body', { value: String(d.value ?? ''), ceiling: String(d.statutoryCeiling ?? '') })}
        </p>
        <Seal citation={citation} ceiling={d.statutoryCeiling} />
      </div>
    )
  }

  return (
    <div className="floor-violation">
      <p className="floor-violation__title">{t(envelope.message_i18n_key)}</p>
    </div>
  )
}

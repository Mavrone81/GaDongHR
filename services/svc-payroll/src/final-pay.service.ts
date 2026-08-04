import { CryptoClient } from '@gadong/kernel'
import type { Queryable } from '@gadong/kernel'
import { payProfileNotFound, statutoryCauseCitationRequired, terminationNotRecorded } from './errors'
import type { Satang } from './money'
import { dailyWage, payInLieuOfNotice, serviceLength, severanceAmount, severanceDays } from './engine/severance'
import type { ServiceLength } from './engine/severance'
import { RULE_KEYS, StatutoryResolver } from './statutory'
import type { SeveranceTier } from './statutory'
import type { ConfigClient } from './config-client'
import { PayProfilesService } from './pay-profiles.service'
import { PayInputsRepository } from './pay-inputs.repository'
import { RefsRepository } from './refs.repository'
import { encryptMoneyFields } from './money-crypto'

/**
 * M7-7 — termination pay.
 *
 *   outstanding wages and OT to the last day  (the final-pay RUN computes
 *     these through the ordinary gross-to-net engine)
 * + unused-leave payout                        (from `leave.balance_payout`,
 *     already queued as a `pay_input` by the consumer)
 * + severance by the LPA s.118 tiers           (this file)
 * + pay in lieu of notice, LPA s.17            (this file)
 *
 * WHAT THIS FILE DOES NOT CONTAIN: the tiers. 30/90/180/240/300/400 days
 * live in `severance.tiers` in the rule pack. Nor does it contain the
 * notice period, the daily-wage divisor, or whether severance is taxable —
 * all four are config, all four are cited on the result.
 *
 * STATUTORY CAUSE. Section 119 lets an employer withhold severance for
 * specific misconduct. This service will produce a zero-severance final pay
 * ONLY when a cause AND its citation are recorded (PAY-060); the database
 * carries the same rule as `termination_statutory_cause_check`. An
 * employer who dismisses for cause and records nothing gets an error, not
 * a quietly cheaper payroll — because "we had a reason" with no
 * contemporaneous record is not a defence in a Thai labour court, and the
 * system should not make it easy to create that situation.
 */

export interface FinalPayComponent {
  code: string
  amount: Satang
  citation: string | null
}

export interface FinalPayAssessment {
  employeeId: string
  terminationDate: string
  reasonCategory: string
  service: ServiceLength
  severanceDays: number
  severanceTier: SeveranceTier | null
  severance: Satang
  noticeInLieu: Satang
  /** Present when severance was withheld: the s.119 cause and the citation recorded with it. */
  withheldCause: { cause: string; citation: string } | null
  components: FinalPayComponent[]
  /** The taxable / SSO classification the queued inputs were given, resolved from config. */
  classification: { severanceTaxable: boolean; severanceSsoWageBase: boolean }
}

export class FinalPayService {
  constructor(
    private readonly refs: RefsRepository,
    private readonly profilesService: PayProfilesService,
    private readonly payInputs: PayInputsRepository,
    private readonly config: ConfigClient,
    private readonly crypto: CryptoClient,
    private readonly newId: () => string,
  ) {}

  /**
   * Assesses severance and notice-in-lieu for one terminating employee and
   * QUEUES them as `pay_input` rows, so the final-pay run picks them up
   * through the same path as every other amount — one engine, one payslip,
   * one set of statutory classifications.
   */
  async assess(tx: Queryable, employeeId: string, period: string): Promise<FinalPayAssessment> {
    const termination = await this.refs.findTermination(employeeId, tx)
    if (termination === null) throw terminationNotRecorded(employeeId)

    const employee = await this.refs.findEmployee(employeeId, tx)
    if (employee === null || employee.startDate === null) throw terminationNotRecorded(employeeId)

    const profile = await this.profilesService.decrypt(employeeId, 'payroll.final_pay', tx)
    if (profile === null) throw payProfileNotFound(employeeId)

    const resolver = new StatutoryResolver(this.config, termination.terminationDate)
    const [tiers, divisor, hoursPerDay, noticePeriods, severanceTaxable, severanceSso] = await Promise.all([
      resolver.severanceTiers(),
      resolver.requiredCount(RULE_KEYS.severanceDailyWageDivisor),
      resolver.requiredCount(RULE_KEYS.otHourlyBaseHours),
      resolver.requiredCount(RULE_KEYS.noticePeriods),
      resolver.requiredFlag(RULE_KEYS.severanceTaxable),
      resolver.requiredFlag(RULE_KEYS.severanceSsoWageBase),
    ])

    const service = serviceLength(employee.startDate, termination.terminationDate)
    const perDay = dailyWage(profile.basis, profile.basePay, divisor.value, hoursPerDay.value)

    // s.119: severance may be withheld, but only against a recorded cause
    // AND citation. Recording one without the other is refused here and by
    // the DB CHECK.
    const causeRecorded = termination.statutoryCause !== null
    const citationRecorded = termination.statutoryCitation !== null
    if (causeRecorded !== citationRecorded) throw statutoryCauseCitationRequired(employeeId)

    const entitlement = severanceDays(tiers, service)
    const severance = causeRecorded ? 0n : severanceAmount(perDay, entitlement.days)

    // Notice in lieu is owed on the same basis regardless of s.119 cause
    // being recorded for severance — the two are different obligations
    // (s.17 vs s.118) and conflating them is a common and expensive error.
    const periodWage = profile.basis === 'monthly' ? profile.basePay : perDay * divisor.value
    const noticeInLieu = payInLieuOfNotice(periodWage, noticePeriods.value, termination.noticeGiven)

    const components: FinalPayComponent[] = []
    if (severance > 0n) {
      components.push({ code: 'severance', amount: severance, citation: entitlement.tier?.citation ?? null })
      await this.queue(tx, employeeId, period, 'severance', 'severance', severance, severanceTaxable.value, severanceSso.value)
    }
    if (noticeInLieu > 0n) {
      components.push({ code: 'notice_in_lieu', amount: noticeInLieu, citation: noticePeriods.citation })
      // Pay in lieu of notice IS wages for the period it replaces, so it
      // carries the same classification ordinary wages do.
      await this.queue(tx, employeeId, period, 'notice_in_lieu', 'notice_in_lieu', noticeInLieu, true, true)
    }

    return {
      employeeId,
      terminationDate: termination.terminationDate,
      reasonCategory: termination.reasonCategory,
      service,
      severanceDays: causeRecorded ? 0 : entitlement.days,
      severanceTier: entitlement.tier,
      severance,
      noticeInLieu,
      withheldCause:
        causeRecorded && termination.statutoryCause !== null && termination.statutoryCitation !== null
          ? { cause: termination.statutoryCause, citation: termination.statutoryCitation }
          : null,
      components,
      classification: { severanceTaxable: severanceTaxable.value, severanceSsoWageBase: severanceSso.value },
    }
  }

  private async queue(
    tx: Queryable,
    employeeId: string,
    period: string,
    source: 'severance' | 'notice_in_lieu',
    kind: string,
    amount: Satang,
    taxable: boolean,
    ssoWageBase: boolean,
  ): Promise<void> {
    const id = this.newId()
    const cipher = await encryptMoneyFields(this.crypto, id, { amount })
    const buf = cipher.get('amount')
    if (buf === undefined) throw new Error('FinalPayService: svc-crypto did not return amount ciphertext')
    await this.payInputs.insert(tx, {
      id,
      employeeId,
      period,
      source,
      // The UNIQUE (source, source_ref) means a re-assessment of the same
      // termination cannot queue a second severance line.
      sourceRef: `${employeeId}:${period}`,
      kind,
      amount: buf,
      taxable,
      ssoWageBase,
      direction: 'earning',
      // Severance and notice-in-lieu are one-off payments: under the
      // annualised withholding method they are added to projected annual
      // income ONCE, never multiplied across the remaining periods.
      meta: { oneOff: true },
    })
  }
}

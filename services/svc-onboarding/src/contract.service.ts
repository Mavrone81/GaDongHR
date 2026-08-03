import { CryptoClient } from '@gadong/kernel'
import { EmployeeRepository } from './employee.repository'
import type { Lang } from './employee.repository'
import type { DocsClient, DocsMergeFieldValue } from './docs-client'
import { employeeNotFound } from './onboarding-errors'

export interface GenerateContractInput {
  templateId: string
  lang: Lang
  /** Free-text merge overrides (e.g. a negotiated salary line, a custom clause) — always rendered as `{type: 'text'}`, never used to smuggle a structured value past `svc-docs`'s own merge-field typing. */
  mergeOverrides?: Record<string, string>
}

export interface GeneratedContract {
  id: string
  sha256: string
}

/** The purpose recorded on every decrypt this service performs — contract merge fields are S2 only (names/address contact details); no S3 field (national ID, bank account, tax ID, SSO number) is ever decrypted for a contract merge field. */
const CONTRACT_GENERATION_PURPOSE = 'contract.generation'

/**
 * Business logic behind `POST /employees/:id/contracts` (M1-4). Thin by
 * design: `svc-docs` (via `DocsClient`) owns rendering and storage — this
 * service's only job is decrypting the S2 fields a contract needs to print
 * and handing plaintext to `svc-docs` over the wire (consistent with the
 * architecture: transport is TLS-protected: roadmap "Data classification"
 * table). No S3 field is ever included — a Thai employment contract's merge
 * fields (name, position, start date, employment type) do not need
 * national ID/bank account/tax ID/SSO number, so this class has no
 * S3-decrypt code path at all, and therefore nothing here requires the
 * `GET /employees/:id/sensitive` audited path.
 *
 * No local DB write: the generated document is owned entirely by
 * `docs.document` (`svc-docs`'s own schema) — `onboarding` has nothing to
 * persist about a contract beyond what `svc-docs`'s response already
 * returns to the caller.
 */
export class ContractService {
  constructor(
    private readonly employeeRepo: EmployeeRepository,
    private readonly crypto: CryptoClient,
    private readonly docsClient: DocsClient,
  ) {}

  async generate(employeeId: string, input: GenerateContractInput): Promise<GeneratedContract> {
    const employee = await this.employeeRepo.findById(employeeId)
    if (!employee) throw employeeNotFound(employeeId)

    const [firstNameTh, lastNameTh, firstNameEn, lastNameEn] = await Promise.all([
      this.crypto.decrypt(employeeId, 'first_name_th', employee.firstNameTh, CONTRACT_GENERATION_PURPOSE),
      this.crypto.decrypt(employeeId, 'last_name_th', employee.lastNameTh, CONTRACT_GENERATION_PURPOSE),
      this.crypto.decrypt(employeeId, 'first_name_en', employee.firstNameEn, CONTRACT_GENERATION_PURPOSE),
      this.crypto.decrypt(employeeId, 'last_name_en', employee.lastNameEn, CONTRACT_GENERATION_PURPOSE),
    ])

    const mergeFields: Record<string, DocsMergeFieldValue> = {
      employeeNameTh: { type: 'text', value: `${firstNameTh} ${lastNameTh}` },
      employeeNameEn: { type: 'text', value: `${firstNameEn} ${lastNameEn}` },
      empCode: { type: 'text', value: employee.empCode },
      employmentType: { type: 'text', value: employee.employmentType },
      startDate: { type: 'date', value: employee.startDate },
    }
    for (const [key, value] of Object.entries(input.mergeOverrides ?? {})) {
      mergeFields[key] = { type: 'text', value }
    }

    return this.docsClient.render({
      kind: input.templateId,
      lang: input.lang,
      entityType: 'employee',
      entityId: employeeId,
      mergeFields,
    })
  }
}

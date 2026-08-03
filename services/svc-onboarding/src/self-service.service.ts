import { idempotent } from '@gadong/kernel'
import type { Queryable } from '@gadong/kernel'
import { EmployeeService } from './employee.service'
import type { CreateEmployeeInput } from './employee.service'

/**
 * `POST /self-service/{token}` (M1-ONBOARDING §3.1 row 8) — the employee
 * submits their own personal data via a signed one-time link. Document
 * upload (ID card/house registration/bank book, ClamAV-scanned multipart)
 * is out of this task's scope (see the report's Deviations); this class
 * covers the personal-data-submission half, which is also where this
 * module's one genuinely retry-prone, externally-triggered write lives —
 * an ESS client on a flaky connection can and does resubmit the same form.
 *
 * M1 has no `in` events in the roadmap's catalog (it is "upstream source of
 * truth" — nothing to consume). This submission path is the closest
 * analogue in this module to the XC-EVENTS "triple delivery produces one
 * effect" contract every consumer must satisfy: the caller supplies a
 * `submissionId` (an idempotency key the ESS client generates once per
 * submission attempt and repeats verbatim on retry), and kernel's
 * `idempotent()` — the exact mechanism a broker-event consumer would use —
 * guarantees the underlying `EmployeeService.commitUpdate` (the state
 * change + its `employee.updated` outbox event) runs at most once no
 * matter how many times the same `submissionId` arrives.
 *
 * `prepareUpdate` (crypto calls) deliberately runs OUTSIDE `idempotent()`:
 * redundantly re-encrypting the same plaintext on a retry is wasted work,
 * not a correctness problem, whereas the DB effect itself must not
 * duplicate. This mirrors `EmployeeService`'s own prepare/commit split.
 */
export class SelfServiceService {
  constructor(private readonly employeeService: EmployeeService) {}

  async submit(
    tx: Queryable,
    submissionId: string,
    employeeId: string,
    patch: Partial<CreateEmployeeInput>,
    actorId: string,
    actorRole: string,
  ): Promise<{ id: string; empCode: string } | 'duplicate'> {
    const prepared = await this.employeeService.prepareUpdate(employeeId, patch)
    return idempotent(tx, 'onboarding', submissionId, () => this.employeeService.commitUpdate(tx, prepared, actorId, actorRole))
  }
}

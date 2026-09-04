/**
 * Resolving a recipient id to a real mailbox.
 *
 * Until this existed, `notify.service.ts` addressed every message to
 * `placeholderEmailAddress(recipientUserId)` — `<uuid>@users.gadonghr
 * .invalid`. That was a deliberate Phase 1 stand-in: svc-onboarding did
 * not exist yet, and no event in the catalog carries an email address
 * (`employee.created`'s payload has none, and email is S2-class PII the
 * catalog says must be "fetched by ID through the owning service's
 * audited API"). It was harmless while SMTP was misconfigured and every
 * send failed at connect.
 *
 * It stopped being harmless the moment SMTP started working: `.invalid`
 * is a reserved TLD that can never resolve, so every notification became
 * a guaranteed bounce against a real, young, reputation-sensitive mail
 * account.
 *
 * The address is read through svc-onboarding's audited
 * `GET /employees/:id/sensitive` — never by querying its schema, which
 * this service could not do anyway (one schema per service, no
 * cross-schema reads). The `purpose` is mandatory on that endpoint and
 * lands in the audit chain, which is exactly the PDPA property wanted
 * here: every read of an employee's email for a notification is
 * attributable after the fact.
 */
export interface EmployeeDirectory {
  /**
   * The employee's email address, or `null` when there is genuinely none
   * on file.
   *
   * Implementations MUST NOT throw for an ordinary "no address" answer —
   * `null` is a normal outcome that the caller records as a failed
   * delivery. Throwing is reserved for the directory itself being
   * unreachable or refusing the call, which the caller also handles, but
   * distinguishes in the error it records.
   */
  lookupEmail(employeeId: string): Promise<string | null>
}

/** The `purpose` recorded in svc-onboarding's audit entry for every lookup this service makes. Narrow on purpose: it names why the read happened, not merely which service made it. */
export const NOTIFY_EMAIL_PURPOSE = 'notify.email_delivery'

export class HttpEmployeeDirectory implements EmployeeDirectory {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async lookupEmail(employeeId: string): Promise<string | null> {
    const url =
      `${this.baseUrl.replace(/\/+$/, '')}/employees/${encodeURIComponent(employeeId)}/sensitive` +
      `?fields=email&purpose=${encodeURIComponent(NOTIFY_EMAIL_PURPOSE)}`

    const res = await this.fetchImpl(url, { method: 'GET' })

    // A recipient who is not an employee svc-onboarding knows about is a
    // real, expected case (a system account, or a record erased under
    // PDPA retention between the event and this send). It is "no address",
    // not a fault, and must not be retried or logged as an outage.
    if (res.status === 404) return null
    if (!res.ok) {
      throw new Error(`svc-onboarding returned ${res.status.toString()} resolving a notification recipient's email`)
    }

    const body: unknown = await res.json()
    if (typeof body !== 'object' || body === null) return null
    const email = (body as Record<string, unknown>)['email']
    // The endpoint answers `{field: value | null}`; a null or absent email
    // means the employee has none on file. Validated rather than cast —
    // a 200 with an unusable body must take the same "no address" path as
    // an honest null, not reach nodemailer as `undefined`.
    if (typeof email !== 'string' || email.trim().length === 0) return null
    return email
  }
}

import { randomUUID } from 'node:crypto'
import { AuditEmitter } from '@gadong/kernel'
import type { Queryable } from '@gadong/kernel'
import { ConsentStateRepository } from './consent-state.repository'
import { EnrolmentRepository } from './enrolment.repository'
import type { EnrolmentRow } from './enrolment.repository'
import { AlternativeCredentialRepository } from './alternative-credential.repository'
import type { AlternativeKind } from './alternative-credential.repository'
import { hashLookupCode, hashPin } from './credential-hash'
import type { FaceEngineAdapter } from './face-engine.adapter'
import { captureQualityInsufficient, enrolmentAlreadyExists, enrolmentRequiresConsent, enrolmentSessionNotFound } from './attendance-errors'

export interface StartEnrolmentResult {
  session: string
}

export interface CompleteEnrolmentInput {
  session: string
  /** Optional — if omitted, the frames previously buffered via `addFrame` (`POST /enrolments/:session/frames`) are used instead. Direct `images` stays supported for the mobile/one-shot capture flow, and is what most tests exercise. */
  images?: Buffer[]
}

export interface AlternativeEnrolmentInput {
  employeeId: string
  kind: AlternativeKind
  code: string
}

/**
 * M4-1: "Technically impossible until explicit biometric consent exists."
 * `startEnrolment`/`completeEnrolment` both check
 * `ConsentStateRepository.isGranted` — `completeEnrolment` checks it AGAIN
 * (not just trusting that `startEnrolment` once did), because consent can
 * be withdrawn in the gap between starting a capture session and
 * completing it, and an enrolment that slips through that gap would be
 * exactly the violation this gate exists to prevent.
 *
 * Raw enrolment images are handed straight to `FaceEngineAdapter.enrol` and
 * never otherwise written to disk or a database column by this service
 * (M4-1: "Raw images are never persisted by this service") — there is no
 * repository method anywhere in this file that accepts an image and stores
 * it; `images` only ever flows into `faceEngine.enrol`.
 */
export class EnrolmentService {
  /** Capture sessions are ephemeral and in-memory only — never persisted (no raw image, and no need to survive a restart: a lost session just means the employee starts capture again). `images` buffers frames submitted via `addFrame` (`POST /enrolments/:session/frames`) until `completeEnrolment` consumes them. */
  private readonly sessions = new Map<string, { employeeId: string; images: Buffer[] }>()

  constructor(
    private readonly consentState: ConsentStateRepository,
    private readonly enrolmentRepo: EnrolmentRepository,
    private readonly altCredentialRepo: AlternativeCredentialRepository,
    private readonly faceEngine: FaceEngineAdapter,
    private readonly audit: AuditEmitter,
    private readonly credentialPepper: string,
  ) {}

  async startEnrolment(employeeId: string, db: Queryable): Promise<StartEnrolmentResult> {
    if (!(await this.consentState.isGranted(employeeId))) throw enrolmentRequiresConsent()

    const existing = await this.enrolmentRepo.findByEmployeeId(db, employeeId)
    if (existing && existing.status !== 'deleted') throw enrolmentAlreadyExists(employeeId)

    const session = randomUUID()
    this.sessions.set(session, { employeeId, images: [] })
    return { session }
  }

  /** `POST /enrolments/:session/frames` — buffers one guided-capture frame against an open session. Frames are held only in this in-memory map, never written to disk or a DB column (M4-1). */
  addFrame(session: string, image: Buffer): void {
    const sessionState = this.sessions.get(session)
    if (!sessionState) throw enrolmentSessionNotFound(session)
    sessionState.images.push(image)
  }

  async completeEnrolment(
    tx: Queryable,
    input: CompleteEnrolmentInput,
    actorId: string,
    actorRole: string,
  ): Promise<EnrolmentRow> {
    const sessionState = this.sessions.get(input.session)
    if (!sessionState) throw enrolmentSessionNotFound(input.session)
    const { employeeId } = sessionState
    const images = input.images ?? sessionState.images
    if (images.length === 0) throw captureQualityInsufficient('no_frames_captured')

    // Re-checked here — see class doc: consent can be withdrawn mid-capture.
    if (!(await this.consentState.isGranted(employeeId))) throw enrolmentRequiresConsent()

    const existing = await this.enrolmentRepo.findByEmployeeId(tx, employeeId)
    if (existing && existing.status !== 'deleted') throw enrolmentAlreadyExists(employeeId)

    const { subjectRef } = await this.faceEngine.enrol(employeeId, images)
    this.sessions.delete(input.session)

    const row = await this.enrolmentRepo.insert(tx, { id: randomUUID(), employeeId, method: 'face', faceSubjectRef: subjectRef })
    await this.audit.emit(tx, 'attendance', {
      actorId, actorRole, action: 'enrolment.completed', entity: 'enrollment', entityId: employeeId, after: { method: 'face' },
    })
    return row
  }

  /** M4-5: PIN/QR/badge for employees without biometric consent, failed matches, or device issues. Stores a keyed HMAC, never the raw code — `credential-hash.ts`. */
  async enrolAlternative(tx: Queryable, input: AlternativeEnrolmentInput, actorId: string, actorRole: string): Promise<void> {
    const hash = input.kind === 'pin' ? hashPin(this.credentialPepper, input.employeeId, input.code) : hashLookupCode(this.credentialPepper, input.kind, input.code)
    await this.altCredentialRepo.upsert(tx, input.employeeId, input.kind, hash)

    const existing = await this.enrolmentRepo.findByEmployeeId(tx, input.employeeId)
    if (!existing) {
      await this.enrolmentRepo.insert(tx, { id: randomUUID(), employeeId: input.employeeId, method: input.kind, faceSubjectRef: null })
    }

    await this.audit.emit(tx, 'attendance', {
      actorId, actorRole, action: 'enrolment.alternative_set', entity: 'enrollment', entityId: input.employeeId, after: { kind: input.kind },
    })
  }

  /** Test/diagnostic hook — session existence without exposing the private map. */
  hasSession(session: string): boolean {
    return this.sessions.has(session)
  }
}

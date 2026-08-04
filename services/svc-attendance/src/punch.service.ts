import { randomUUID } from 'node:crypto'
import { writeOutbox } from '@gadong/kernel'
import type { Queryable } from '@gadong/kernel'
import { EnrolmentRepository } from './enrolment.repository'
import { AlternativeCredentialRepository } from './alternative-credential.repository'
import type { AlternativeKind } from './alternative-credential.repository'
import { PunchRepository } from './punch.repository'
import type { InsertPunchResult, NewPunchRow, PunchDirection } from './punch.repository'
import { SecurityEventRepository } from './security-event.repository'
import type { FaceEngineAdapter } from './face-engine.adapter'
import type { LivenessChecker } from './liveness.checker'
import type { ConfigClient } from './config-client'
import { hashLookupCode, hashPin } from './credential-hash'
import {
  faceEngineUnavailable,
  invalidAlternativeCredential,
  livenessCheckFailed,
  noMatchAboveThreshold,
} from './attendance-errors'

const MATCH_THRESHOLD_RULE_KEY = 'attendance.match_threshold'

export interface FacePunchInput {
  deviceId: string
  idemKey: string
  direction: PunchDirection
  siteCode: string
  punchedAt: string
  frame: Buffer
}

export interface VerifyPunchInput {
  deviceId: string
  idemKey: string
  direction: PunchDirection
  siteCode: string
  punchedAt: string
  employeeId: string
  sessionToken: string
  frame: Buffer
}

export interface CodePunchInput {
  deviceId: string
  idemKey: string
  direction: PunchDirection
  siteCode: string
  punchedAt: string
  kind: AlternativeKind
  code: string
  /** Required for `kind: 'pin'` (the kiosk/PWA already knows who is punching); ignored for `qr`/`badge`, which resolve the employee FROM the scanned code. */
  employeeId?: string
}

/**
 * The punch pipeline (M4-2/M4-3/M4-4/M4-5/M4-6). Every accepted punch —
 * regardless of which of the three `record*` methods produced it — goes
 * through the SAME `insertPunch` → `PunchRepository.insert` →
 * `attendance.punch` outbox publish path, which is exactly what makes M4-5
 * true: Timesheet consumes one event shape, method-agnostic.
 *
 * `insertPunch` is also where the M4-4/M4-6 replay guarantee lives: it
 * trusts `PunchRepository.insert`'s `ON CONFLICT (idem_key) DO NOTHING`
 * completely — a duplicate delivery returns the ORIGINAL row and does
 * NOT re-publish `attendance.punch` (the row was already published, or is
 * already queued to be, from the first successful insert).
 */
export class PunchService {
  constructor(
    private readonly punchRepo: PunchRepository,
    private readonly enrolmentRepo: EnrolmentRepository,
    private readonly altCredentialRepo: AlternativeCredentialRepository,
    private readonly securityEventRepo: SecurityEventRepository,
    private readonly faceEngine: FaceEngineAdapter,
    private readonly liveness: LivenessChecker,
    private readonly config: ConfigClient,
    private readonly credentialPepper: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** M4-2 kiosk: 1:N identify. */
  async recordFacePunch(tx: Queryable, input: FacePunchInput): Promise<InsertPunchResult> {
    await this.enforceLiveness(tx, () => this.liveness.passiveCheck(input.frame), input.deviceId, null, input.siteCode)

    const matches = await this.identifyOrFallback(input.frame)
    const threshold = await this.config.getNumericRule(MATCH_THRESHOLD_RULE_KEY)
    const best = matches[0]
    if (!best || best.score < threshold) throw noMatchAboveThreshold()

    const enrolment = await this.enrolmentRepo.findByFaceSubjectRef(tx, best.subjectRef)
    if (!enrolment || enrolment.status !== 'active') throw noMatchAboveThreshold()

    return this.insertPunch(tx, {
      employeeId: enrolment.employeeId, deviceId: input.deviceId, idemKey: input.idemKey, punchedAt: input.punchedAt,
      direction: input.direction, method: 'face', matchScore: best.score, livenessPassed: true, siteCode: input.siteCode, geo: null,
    })
  }

  /** M4-2/M4-3 mobile PWA: 1:1 verify against the caller's OWN already-known identity. */
  async recordVerifyPunch(tx: Queryable, input: VerifyPunchInput): Promise<InsertPunchResult> {
    await this.enforceLiveness(
      tx,
      () => this.liveness.activeChallenge(input.sessionToken, input.frame),
      input.deviceId,
      input.employeeId,
      input.siteCode,
    )

    const enrolment = await this.enrolmentRepo.findByEmployeeId(tx, input.employeeId)
    if (!enrolment || enrolment.status !== 'active' || enrolment.faceSubjectRef === null) throw noMatchAboveThreshold()

    let result
    try {
      result = await this.faceEngine.verify(enrolment.faceSubjectRef, input.frame)
    } catch {
      throw faceEngineUnavailable()
    }

    const threshold = await this.config.getNumericRule(MATCH_THRESHOLD_RULE_KEY)
    if (result.score < threshold) throw noMatchAboveThreshold()

    return this.insertPunch(tx, {
      employeeId: input.employeeId, deviceId: input.deviceId, idemKey: input.idemKey, punchedAt: input.punchedAt,
      direction: input.direction, method: 'face', matchScore: result.score, livenessPassed: true, siteCode: input.siteCode, geo: null,
    })
  }

  /**
   * M4-5: PIN/QR/badge. No liveness, no face engine — this is the legal
   * control, not a degraded fallback, so it must work exactly as reliably
   * whether or not the face engine is even reachable (see
   * `recordFacePunch`'s `identifyOrFallback` — the same reachability
   * problem this method is entirely immune to by construction).
   */
  async recordCodePunch(tx: Queryable, input: CodePunchInput): Promise<InsertPunchResult> {
    const employeeId = await this.resolveAlternativeCredential(tx, input)

    return this.insertPunch(tx, {
      employeeId, deviceId: input.deviceId, idemKey: input.idemKey, punchedAt: input.punchedAt,
      direction: input.direction, method: input.kind, matchScore: null, livenessPassed: null, siteCode: input.siteCode, geo: null,
    })
  }

  /** `POST /punches/batch` — a kiosk's offline-spooled queue, already decided locally while disconnected. No re-matching: this is purely the idempotent-insert replay path (M4-4/M4-6). */
  async replayBatch(tx: Queryable, rows: Array<Omit<NewPunchRow, 'id'>>): Promise<InsertPunchResult[]> {
    const results: InsertPunchResult[] = []
    for (const row of rows) {
      results.push(await this.insertPunch(tx, row))
    }
    return results
  }

  private async resolveAlternativeCredential(tx: Queryable, input: CodePunchInput): Promise<string> {
    if (input.kind === 'pin') {
      if (!input.employeeId) throw invalidAlternativeCredential()
      const cred = await this.altCredentialRepo.findByEmployeeId(tx, input.employeeId)
      const hash = hashPin(this.credentialPepper, input.employeeId, input.code)
      if (!cred || !cred.credentialHash.equals(hash)) throw invalidAlternativeCredential()
      return input.employeeId
    }
    const hash = hashLookupCode(this.credentialPepper, input.kind, input.code)
    const cred = await this.altCredentialRepo.findByHash(tx, hash)
    if (!cred) throw invalidAlternativeCredential()
    return cred.employeeId
  }

  /** CompreFace unreachable ⇒ callers fall back to `recordCodePunch` — this method exists so that fallback decision is made ONCE, at the identify call site, rather than every caller re-deriving it. */
  private async identifyOrFallback(frame: Buffer) {
    try {
      return await this.faceEngine.identify(frame)
    } catch {
      throw faceEngineUnavailable()
    }
  }

  private async enforceLiveness(
    tx: Queryable,
    check: () => Promise<{ passed: boolean; score: number }>,
    deviceId: string,
    employeeId: string | null,
    siteCode: string,
  ): Promise<void> {
    const result = await check()
    if (result.passed) return

    await this.securityEventRepo.insert(tx, {
      id: randomUUID(), kind: 'liveness_failed', deviceId, employeeId, siteCode, at: this.now().toISOString(),
    })
    await writeOutbox(tx, 'attendance', 'attendance.liveness_failed', { deviceId, at: this.now().toISOString(), siteCode })
    throw livenessCheckFailed()
  }

  private async insertPunch(tx: Queryable, row: Omit<NewPunchRow, 'id'>): Promise<InsertPunchResult> {
    const result = await this.punchRepo.insert(tx, { id: randomUUID(), ...row })
    if (!result.duplicate) {
      await writeOutbox(tx, 'attendance', 'attendance.punch', {
        idemKey: result.row.idemKey,
        employeeId: result.row.employeeId,
        deviceId: result.row.deviceId,
        punchedAt: result.row.punchedAt,
        direction: result.row.direction,
        method: result.row.method,
        siteCode: result.row.siteCode,
        matchScore: result.row.matchScore,
        livenessPassed: result.row.livenessPassed,
      })
    }
    return result
  }
}

import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto'
import { AuditEmitter, CryptoClient } from '@gadong/kernel'
import type { Queryable } from '@gadong/kernel'
import { DeviceRepository } from './device.repository'
import type { DeviceKind, DeviceRow } from './device.repository'
import { deviceApprovalRequiresSecondPerson, deviceNotApproved, deviceNotFound } from './attendance-errors'

const DEVICE_SECRET_FIELD = 'device_secret'
const DEVICE_SECRET_PURPOSE = 'attendance.device.hmac_verify'

export interface RegisterDeviceInput {
  kind: DeviceKind
  siteCode: string
  /** The device's raw HMAC secret, generated client-side or by the registering console — envelope-encrypted before it ever reaches a repository/DB call. */
  secret: string
}

/**
 * Kiosk/mobile device lifecycle (module doc §3, row 10): registration,
 * then a REQUIRED second-person approval (`registeredBy !== approvedBy`,
 * segregation of duties — kernel's `sodViolation` shape, attendance's own
 * instance of it is `deviceApprovalRequiresSecondPerson`), and HMAC
 * signature verification for the kiosk-authenticated punch endpoints
 * (module doc: "Kiosk endpoints authenticate with per-device HMAC
 * secret").
 */
export class DeviceService {
  constructor(
    private readonly deviceRepo: DeviceRepository,
    private readonly crypto: CryptoClient,
    private readonly audit: AuditEmitter,
  ) {}

  async register(tx: Queryable, input: RegisterDeviceInput, registeredBy: string, actorRole: string): Promise<DeviceRow> {
    const id = randomUUID()
    const ciphertexts = await this.crypto.encryptBatch([{ entityId: id, field: DEVICE_SECRET_FIELD, value: input.secret, fieldClass: 'S3' }])
    const deviceSecret = ciphertexts.get(DEVICE_SECRET_FIELD)
    if (!deviceSecret) throw new Error('DeviceService.register: encryptBatch did not return the device_secret ciphertext')

    const row = await this.deviceRepo.insert(tx, { id, kind: input.kind, siteCode: input.siteCode, deviceSecret, registeredBy })
    await this.audit.emit(tx, 'attendance', { actorId: registeredBy, actorRole, action: 'device.registered', entity: 'device', entityId: id, after: { kind: input.kind, siteCode: input.siteCode } })
    return row
  }

  /** Second-person approval: `approvedBy` must not be the same actor who registered the device. */
  async approve(tx: Queryable, deviceId: string, approvedBy: string, actorRole: string, now: () => Date = () => new Date()): Promise<DeviceRow> {
    const device = await this.deviceRepo.findById(tx, deviceId)
    if (!device) throw deviceNotFound(deviceId)
    if (device.registeredBy !== null && device.registeredBy === approvedBy) throw deviceApprovalRequiresSecondPerson()

    const approved = await this.deviceRepo.approve(tx, deviceId, approvedBy, now().toISOString())
    if (!approved) throw deviceNotFound(deviceId)

    await this.audit.emit(tx, 'attendance', { actorId: approvedBy, actorRole, action: 'device.approved', entity: 'device', entityId: deviceId })
    return approved
  }

  async list(db: Queryable): Promise<DeviceRow[]> {
    return this.deviceRepo.list(db)
  }

  /**
   * Verifies an incoming kiosk HMAC signature: `hex(HMAC-SHA256(deviceSecret, payload))`.
   * Fails closed — an inactive/unknown device, a decrypt failure, or a mismatched
   * signature all resolve to the same `deviceNotApproved()` (ATT-030), never a
   * distinguishing error an attacker could use to enumerate valid device ids.
   */
  async verifySignature(db: Queryable, deviceId: string, payload: Buffer, signatureHex: string): Promise<DeviceRow> {
    const device = await this.deviceRepo.findById(db, deviceId)
    if (!device || device.status !== 'active') throw deviceNotApproved()

    let secretPlaintext: string
    try {
      secretPlaintext = await this.crypto.decrypt(deviceId, DEVICE_SECRET_FIELD, device.deviceSecret, DEVICE_SECRET_PURPOSE)
    } catch {
      throw deviceNotApproved()
    }

    const expected = createHmac('sha256', secretPlaintext).update(payload).digest()
    const provided = Buffer.from(signatureHex, 'hex')
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) throw deviceNotApproved()

    return device
  }
}

/**
 * The swap point M4-ATTENDANCE.md §2's class diagram calls out explicitly:
 * "`FaceEngineAdapter` is the swap point if CompreFace fails the ADR-007
 * benchmark (fallback: custom InsightFace service)." CompreFace itself
 * cannot run in this environment (host has 4 GB, CompreFace needs 2-3GB —
 * task CONSTRAINTS), so every consumer of this interface is built and
 * tested against `testing/fake-face-engine.ts`, exactly as kernel's
 * `CryptoClient` is tested against a fake `CryptoTransport` for the same
 * "the real dependency cannot run here" reason.
 *
 * Every method returns an OPAQUE reference (`subjectRef`) or a score —
 * never bytes that could be an embedding. That is not merely a style
 * choice: it is the actual mechanism keeping GaDongHR's central PDPA
 * guarantee true (no biometric template is ever stored outside the face
 * engine itself — DATABASE-DESIGN.md §2.2, `attendance-schema.test.ts`'s
 * "no column can hold a face embedding" suite). No method on this
 * interface has a return type that could hold one.
 */

/** Result of enrolling a new face subject. `subjectRef` is CompreFace's own opaque subject id — the ONLY thing this service ever persists (`attendance.enrollment.face_subject_ref`, `text`). */
export interface FaceEnrolResult {
  subjectRef: string
}

/** Result of a 1:1 verify (mobile PWA, M4-3) against a known subject. */
export interface FaceVerifyResult {
  score: number
}

/** One candidate from a 1:N identify (kiosk, M4-2) — sorted by score, highest first. */
export interface FaceMatch {
  subjectRef: string
  score: number
}

/**
 * Result of a delete-and-verify (PDPA §7). `verified` is true only when the
 * engine's own state, re-checked AFTER the delete call, confirms the
 * subject is gone — never inferred from the delete call not throwing.
 * "Assumed deleted" is exactly the failure mode this field exists to rule
 * out (task brief: "deletion is verified against the engine rather than
 * assumed").
 */
export interface FaceDeleteResult {
  verified: boolean
}

export interface FaceEngineAdapter {
  /** Creates a subject for `employeeId` and enrols one or more guided-capture images against it. Raw images are handed to the engine and never otherwise persisted by this service (M4-1). */
  enrol(employeeId: string, images: Buffer[]): Promise<FaceEnrolResult>

  /** 1:1 verify — M4-3 mobile PWA flow: the user is already OIDC-authenticated, so this only needs to confirm the presented face matches their OWN enrolled subject. */
  verify(subjectRef: string, image: Buffer): Promise<FaceVerifyResult>

  /** 1:N identify — M4-2 kiosk flow: no claimed identity, so every enrolled subject is a candidate. */
  identify(image: Buffer): Promise<FaceMatch[]>

  /** Deletes a subject AND verifies the deletion against the engine's own state before returning — see `FaceDeleteResult`. */
  deleteSubject(subjectRef: string): Promise<FaceDeleteResult>
}

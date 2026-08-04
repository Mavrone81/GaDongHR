/**
 * M4-3: "active or passive liveness to defeat photo/video replay." Kept as
 * its own small port, separate from `FaceEngineAdapter` — CompreFace has no
 * liveness endpoint of its own in the ADR-007-benchmarked configuration, and
 * a dedicated liveness model/service (or a client-side SDK result relayed
 * here) is the more likely real implementation either way. Injectable for
 * the same reason every other external dependency in this service is:
 * nothing that calls a real ML model can run in this environment, so
 * `PunchService` is proven against `testing/fake-liveness-checker.ts`.
 */
export interface LivenessResult {
  passed: boolean
  score: number
}

export interface LivenessChecker {
  /** Kiosk (M4-2): passive check on a single captured frame, no user interaction. */
  passiveCheck(frame: Buffer): Promise<LivenessResult>
  /** Mobile PWA (M4-2): active challenge (blink/turn prompt) tied to a session token issued when the challenge began. */
  activeChallenge(sessionToken: string, frame: Buffer): Promise<LivenessResult>
}

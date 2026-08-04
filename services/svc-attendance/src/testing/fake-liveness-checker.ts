import type { LivenessChecker, LivenessResult } from '../liveness.checker'

/**
 * Deterministic fake: every frame passes with `defaultResult` unless a test
 * has set an explicit override for that exact frame (`setResultFor`) —
 * lets a test construct one "live" frame and one "replay" frame and get a
 * predictable, opposite result for each without depending on any real
 * liveness model.
 */
export class FakeLivenessChecker implements LivenessChecker {
  private readonly overrides = new Map<string, LivenessResult>()

  constructor(private readonly defaultResult: LivenessResult = { passed: true, score: 0.95 }) {}

  setResultFor(frame: Buffer, result: LivenessResult): void {
    this.overrides.set(frame.toString('base64'), result)
  }

  async passiveCheck(frame: Buffer): Promise<LivenessResult> {
    return this.overrides.get(frame.toString('base64')) ?? this.defaultResult
  }

  async activeChallenge(_sessionToken: string, frame: Buffer): Promise<LivenessResult> {
    return this.overrides.get(frame.toString('base64')) ?? this.defaultResult
  }
}

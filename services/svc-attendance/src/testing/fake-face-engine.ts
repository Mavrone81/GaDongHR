import type { FaceDeleteResult, FaceEngineAdapter, FaceEnrolResult, FaceMatch, FaceVerifyResult } from '../face-engine.adapter'

/**
 * Stands in for CompreFace (cannot run in this environment — task
 * CONSTRAINTS). "Matching" is deliberately not real face recognition: a
 * probe image matches a subject when it is byte-identical to one of the
 * images that subject was enrolled with (`Buffer.equals`) — enough to
 * exercise every real property this codebase's tests need (a genuine
 * match scores high, an unrelated image scores low, deletion is
 * verifiable) without depending on any actual ML.
 */
export class FakeFaceEngine implements FaceEngineAdapter {
  private readonly subjects = new Map<string, { employeeId: string; images: Buffer[] }>()
  private readonly deleted = new Set<string>()
  /** subjectRef → the engine's DELETE call runs, but the post-delete existence check still reports the subject present — see `simulateStubbornDeletion`. */
  private readonly stubborn = new Set<string>()
  private seq = 0

  /** Simulates CompreFace being unreachable — every call rejects. Used to prove kiosks/mobile fall back to the alternative method (M4-5) rather than lose a punch. */
  unreachable = false

  private readonly matchScore = 0.97
  private readonly noMatchScore = 0.12

  async enrol(employeeId: string, images: Buffer[]): Promise<FaceEnrolResult> {
    this.assertReachable()
    if (images.length === 0) throw new Error('FakeFaceEngine.enrol: at least one image is required')
    this.seq += 1
    const subjectRef = `fake-subj-${employeeId}-${this.seq}`
    this.subjects.set(subjectRef, { employeeId, images })
    return { subjectRef }
  }

  async verify(subjectRef: string, image: Buffer): Promise<FaceVerifyResult> {
    this.assertReachable()
    const subject = this.subjects.get(subjectRef)
    if (!subject || this.deleted.has(subjectRef)) return { score: 0 }
    const isMatch = subject.images.some((stored) => stored.equals(image))
    return { score: isMatch ? this.matchScore : this.noMatchScore }
  }

  async identify(image: Buffer): Promise<FaceMatch[]> {
    this.assertReachable()
    const out: FaceMatch[] = []
    for (const [subjectRef, subject] of this.subjects) {
      if (this.deleted.has(subjectRef)) continue
      const isMatch = subject.images.some((stored) => stored.equals(image))
      out.push({ subjectRef, score: isMatch ? this.matchScore : this.noMatchScore })
    }
    return out.sort((a, b) => b.score - a.score)
  }

  async deleteSubject(subjectRef: string): Promise<FaceDeleteResult> {
    this.assertReachable()
    if (this.stubborn.has(subjectRef)) {
      // The DELETE call itself is issued (production CompreFace semantics:
      // fire the delete either way) but the post-delete GET still reports
      // the subject present — this is the scenario that must fail the
      // whole deletion operation, never pass silently.
      return { verified: false }
    }
    this.deleted.add(subjectRef)
    return { verified: true }
  }

  // --- test-only helpers ---

  /** After this, `deleteSubject(subjectRef)` reports `verified: false` — the engine claims the subject is still present. */
  simulateStubbornDeletion(subjectRef: string): void {
    this.stubborn.add(subjectRef)
  }

  isPresent(subjectRef: string): boolean {
    return this.subjects.has(subjectRef) && !this.deleted.has(subjectRef)
  }

  private assertReachable(): void {
    if (this.unreachable) throw new Error('FakeFaceEngine: engine unreachable (fixture)')
  }
}

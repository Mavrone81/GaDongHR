import type { FaceDeleteResult, FaceEngineAdapter, FaceEnrolResult, FaceMatch, FaceVerifyResult } from './face-engine.adapter'

/**
 * Real HTTP implementation of `FaceEngineAdapter` against CompreFace's
 * Recognition Service REST API. CompreFace cannot run in this environment
 * (task CONSTRAINTS) so this class is never exercised by the test suite —
 * every service that depends on `FaceEngineAdapter` is proven against
 * `testing/fake-face-engine.ts` instead, matching how kernel's
 * `CryptoClient` is proven against a fake `CryptoTransport` for the same
 * "the real dependency cannot run here" reason. This class exists so the
 * swap to a real engine (or the ADR-007-noted InsightFace fallback, behind
 * a second implementation of the same interface) is wiring, not a rewrite.
 *
 * API shape follows CompreFace's documented Recognition Service:
 *   POST   /api/v1/recognition/faces?subject={subjectRef}   (multipart file) — enrol
 *   POST   /api/v1/recognition/recognize                    (multipart file) — 1:N identify
 *   DELETE /api/v1/recognition/faces?subject={subjectRef}                    — delete subject
 *   GET    /api/v1/recognition/faces?subject={subjectRef}                    — verify deletion
 *
 * CompreFace has no built-in 1:1 "verify against a known subject" endpoint
 * distinct from recognize — `verify` here recognises the image and checks
 * whether `subjectRef` appears among the results, taking the best score for
 * that subject (or 0 if absent).
 */
export function createComprefaceAdapter(baseUrl: string, apiKey: string): FaceEngineAdapter {
  function headers(extra: Record<string, string> = {}): Record<string, string> {
    return { 'x-api-key': apiKey, ...extra }
  }

  async function postImage(path: string, image: Buffer): Promise<unknown> {
    const form = new FormData()
    form.append('file', new Blob([image]), 'frame.jpg')
    const res = await fetch(`${baseUrl}${path}`, { method: 'POST', headers: headers(), body: form })
    if (!res.ok) throw new Error(`compreface: POST ${path} responded ${String(res.status)}`)
    return res.json()
  }

  function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null
  }

  function parseResults(body: unknown): FaceMatch[] {
    if (!isRecord(body) || !Array.isArray(body['result'])) return []
    const out: FaceMatch[] = []
    for (const entry of body['result']) {
      if (!isRecord(entry) || !Array.isArray(entry['subjects'])) continue
      for (const subj of entry['subjects']) {
        if (!isRecord(subj)) continue
        const subjectRef = subj['subject']
        const similarity = subj['similarity']
        if (typeof subjectRef === 'string' && typeof similarity === 'number') {
          out.push({ subjectRef, score: similarity })
        }
      }
    }
    return out.sort((a, b) => b.score - a.score)
  }

  return {
    async enrol(employeeId: string, images: Buffer[]): Promise<FaceEnrolResult> {
      if (images.length === 0) throw new Error('createComprefaceAdapter.enrol: at least one image is required')
      const subjectRef = employeeId
      for (const image of images) {
        await postImage(`/api/v1/recognition/faces?subject=${encodeURIComponent(subjectRef)}`, image)
      }
      return { subjectRef }
    },

    async verify(subjectRef: string, image: Buffer): Promise<FaceVerifyResult> {
      const matches = parseResults(await postImage('/api/v1/recognition/recognize', image))
      const own = matches.find((m) => m.subjectRef === subjectRef)
      return { score: own?.score ?? 0 }
    },

    async identify(image: Buffer): Promise<FaceMatch[]> {
      return parseResults(await postImage('/api/v1/recognition/recognize', image))
    },

    async deleteSubject(subjectRef: string): Promise<FaceDeleteResult> {
      const deleteRes = await fetch(`${baseUrl}/api/v1/recognition/faces?subject=${encodeURIComponent(subjectRef)}`, {
        method: 'DELETE',
        headers: headers(),
      })
      if (!deleteRes.ok && deleteRes.status !== 404) {
        throw new Error(`compreface: DELETE faces?subject=${subjectRef} responded ${String(deleteRes.status)}`)
      }

      // Verify against the engine's own state — never assume the DELETE
      // call succeeding means the subject is actually gone (task brief).
      const checkRes = await fetch(`${baseUrl}/api/v1/recognition/faces?subject=${encodeURIComponent(subjectRef)}`, {
        method: 'GET',
        headers: headers(),
      })
      if (checkRes.status === 404) return { verified: true }
      if (!checkRes.ok) return { verified: false }
      const body: unknown = await checkRes.json()
      const stillPresent = isRecord(body) && Array.isArray(body['faces']) && body['faces'].length > 0
      return { verified: !stillPresent }
    },
  }
}

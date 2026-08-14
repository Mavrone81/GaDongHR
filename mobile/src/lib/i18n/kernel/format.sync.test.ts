import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `format.ts` (this directory) is a byte-for-byte copy of
 * `packages/kernel/src/i18n/format.ts` — the satang/Buddhist-Era money and
 * date formatting the task brief requires this app "port or import ... with
 * its tests", never reimplement. `format.test.ts` alongside it is the same
 * copy-with-its-tests treatment for the kernel's own test file, so the
 * exact same assertions travel with the logic.
 *
 * It is a copy, not a runtime import of `@gadong/kernel`, for the same
 * reason `web/src/i18n/fallbackBundle.th.json` is a copy of
 * `services/svc-i18n/bundles/th.json` rather than a cross-package import
 * (see that file's header): `@gadong/kernel`'s package entrypoint
 * (`dist/index.js`) pulls in `amqplib`/`pg`/`@nestjs/*` — none of which
 * bundle for React Native — and even a deep import of the compiled
 * `dist/i18n/format.js` leaf module (the trick `web` uses successfully
 * under Vite) would require Metro to resolve across the pnpm workspace
 * symlink into `packages/kernel/dist`, a monorepo-resolution path this
 * task's verification could not exercise on a device/simulator. A copy is
 * a strictly worse maintenance story than an import UNLESS it is
 * mechanically kept honest — this test is that mechanism: it fails loudly,
 * naming the exact drift, the moment `packages/kernel/src/i18n/format.ts`
 * (or its test file) changes and this copy does not.
 */
describe('mobile/src/lib/i18n/kernel/format.ts stays byte-identical to packages/kernel/src/i18n/format.ts', () => {
  it('matches the canonical kernel source exactly', () => {
    const canonicalPath = join(__dirname, '..', '..', '..', '..', '..', 'packages', 'kernel', 'src', 'i18n', 'format.ts');
    const canonical = readFileSync(canonicalPath, 'utf-8');
    const copy = readFileSync(join(__dirname, 'format.ts'), 'utf-8');
    expect(copy).toBe(canonical);
  });

  it('matches the canonical kernel test file exactly (same test cases travel with the copy)', () => {
    const canonicalPath = join(__dirname, '..', '..', '..', '..', '..', 'packages', 'kernel', 'src', 'i18n', 'format.test.ts');
    const canonical = readFileSync(canonicalPath, 'utf-8');
    const copy = readFileSync(join(__dirname, 'format.test.ts'), 'utf-8');
    expect(copy).toBe(canonical);
  });
});

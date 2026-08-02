/**
 * The image's build stamp. CI injects GADONG_BUILD_SHA at docker build time so
 * a running container traces back to an exact commit — /health reports it and
 * the deploy script asserts on it to prove the new code is actually live.
 */
export function buildVersion(env: NodeJS.ProcessEnv = process.env): string {
  const sha = env.GADONG_BUILD_SHA
  return sha && sha.length > 0 ? sha : 'dev'
}

import { buildVersion } from './version'

export type DependencyState = 'up' | 'down'

export interface HealthPayload {
  status: 'ok' | 'degraded'
  service: string
  version: string
  dependencies: Record<string, DependencyState>
}

/**
 * `degraded` rather than a non-200: the compose healthcheck and the deploy
 * script need to tell "the process is serving" apart from "its dependencies
 * are reachable". Vault starts SEALED after every host reboot by design
 * (Runbook §2), and a sealed Vault must not look like a crashed container.
 */
export function buildHealth(
  service: string,
  dependencies: Record<string, DependencyState>,
  env: NodeJS.ProcessEnv = process.env,
): HealthPayload {
  const anyDown = Object.values(dependencies).some((s) => s === 'down')
  return { status: anyDown ? 'degraded' : 'ok', service, version: buildVersion(env), dependencies }
}

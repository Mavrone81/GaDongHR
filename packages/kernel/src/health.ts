import { buildVersion } from './version'
import type { OutboxDepth } from './outbox/observability'
import { isOutboxStale } from './outbox/observability'

export type DependencyState = 'up' | 'down'

export interface OutboxHealth extends OutboxDepth {
  stale: boolean
}

export interface HealthPayload {
  status: 'ok' | 'degraded'
  service: string
  version: string
  dependencies: Record<string, DependencyState>
  /**
   * Present only for services that pass `outbox` to `buildHealth` — i.e.
   * only services that actually own an outbox table. Optional so every
   * existing caller/test that never had an outbox concept keeps an
   * unchanged response shape (`toEqual` on the old four-field object still
   * passes: Jest's `toEqual` ignores properties whose value is `undefined`).
   */
  outbox?: OutboxHealth
}

/**
 * `degraded` rather than a non-200: the compose healthcheck and the deploy
 * script need to tell "the process is serving" apart from "its dependencies
 * are reachable". Vault starts SEALED after every host reboot by design
 * (Runbook §2), and a sealed Vault must not look like a crashed container.
 *
 * A stale outbox (`isOutboxStale` — rows pending past the threshold, i.e.
 * the relay looks stopped rather than merely busy) degrades the same way a
 * downed dependency does: "a stuck outbox must be observable" only holds if
 * observing it actually changes what `/health` reports, not just what a
 * separate metrics call could compute if someone thought to poll it.
 */
export function buildHealth(
  service: string,
  dependencies: Record<string, DependencyState>,
  env: NodeJS.ProcessEnv = process.env,
  outbox?: OutboxDepth,
): HealthPayload {
  const anyDown = Object.values(dependencies).some((s) => s === 'down')
  const outboxHealth: OutboxHealth | undefined = outbox ? { ...outbox, stale: isOutboxStale(outbox) } : undefined
  const status = anyDown || outboxHealth?.stale === true ? 'degraded' : 'ok'
  return {
    status,
    service,
    version: buildVersion(env),
    dependencies,
    ...(outboxHealth ? { outbox: outboxHealth } : {}),
  }
}

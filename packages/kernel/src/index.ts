export { buildVersion } from './version'
export { GadongError, cryptoUnavailable, permissionDenied, sodViolation } from './errors'
export type { DependencyState, HealthPayload, OutboxHealth } from './health'
export { buildHealth } from './health'
export type { EffectiveRecord } from './effective-date'
export { resolveEffective } from './effective-date'
export type { FieldClass, EncryptRequest, CryptoTransport } from './crypto/types'
export { CryptoClient, isBlankPurpose } from './crypto/client'
export type { OutboxRow, Queryable } from './outbox/outbox'
export { writeOutbox, assertValidSchemaName } from './outbox/outbox'
export type { Publisher } from './outbox/relay'
export { OutboxRelay } from './outbox/relay'
export { idempotent } from './outbox/consumer'
export type { RelayLoopOptions } from './outbox/relay-loop'
export { RelayLoop } from './outbox/relay-loop'
export type { OutboxDepth } from './outbox/observability'
export { outboxDepth, isOutboxStale, DEFAULT_STALE_THRESHOLD_SECONDS } from './outbox/observability'
export { EVENTS_EXCHANGE, DEAD_LETTER_EXCHANGE, deadLetterQueueName, assertTopology, assertServiceQueue } from './bus/topology'
export type { ServiceQueueSpec } from './bus/topology'
export type { AmqpPublisherOptions, AmqpRecoveryOptions } from './bus/publisher'
export { AmqpPublisher } from './bus/publisher'
export type { EventHandler, ConsumerLoopOptions, ConsumerLoopLogger, DeadLetterInfo } from './bus/consumer-loop'
export { ConsumerLoop } from './bus/consumer-loop'
export { RETRY_COUNT_HEADER, LAST_ERROR_HEADER, ORIGINAL_TOPIC_HEADER, SOURCE_QUEUE_HEADER, DEFAULT_MAX_RETRIES, decideRetry, readRetryCount, readOriginalTopic } from './bus/retry'
export type { RetryDecision, AmqpHeaders } from './bus/retry'
export type { EventBus, EventBusOptions, EventBusPublishOptions, EventBusConsumeOptions } from './bus/service-bus'
export { startEventBus } from './bus/service-bus'
export {
  createPool,
  withTransaction,
  withConnection,
  STATEMENT_TIMEOUT_MS,
  QUERY_TIMEOUT_MS,
  CONNECTION_TIMEOUT_MS,
  MAX_POOL_SIZE,
} from './db/pool'
export type { Decision, AuthzTransport, AuthzClientOptions } from './authz/client'
export { AuthzClient, DECISION_CACHE_TTL_MS, DECISION_CACHE_MAX_ENTRIES, AUTHZ_DECIDE_TIMEOUT_MS } from './authz/client'
export type { AuthenticatedRequest } from './authz/guard'
export { RequirePermission, Public, PermissionGuard, PERMISSION_METADATA_KEY, PUBLIC_METADATA_KEY } from './authz/guard'
export { GadongErrorFilter } from './http/gadong-error.filter'
export type {
  OidcAuthenticatedRequest,
  OidcMiddlewareOptions,
  OidcMiddlewareHandler,
  JwksFetcher,
  DebugLogger,
} from './authz/oidc.middleware'
export {
  OidcMiddleware,
  createOidcMiddlewareHandler,
  createHttpJwksFetcher,
  OIDC_JWKS_CACHE_TTL_MS,
  OIDC_JWKS_REFRESH_DEBOUNCE_MS,
  OIDC_JWKS_MAX_KEYS,
} from './authz/oidc.middleware'
export type { TokenResponse, TokenTransport, MachineTokenClientOptions, AuthenticatedFetch } from './authz/machine-token.client'
export { MachineTokenClient, createHttpTokenTransport, createHttpMachineTokenClient, createAuthenticatedFetch } from './authz/machine-token.client'
export type { AuditEntry } from './audit/emitter'
export { AuditEmitter } from './audit/emitter'
export { canonicalJson, hashValue, sha256Hex } from './audit/canonical-json'
export type { Locale } from './i18n/format'
export { toBuddhistEra, formatDate, formatTHB } from './i18n/format'

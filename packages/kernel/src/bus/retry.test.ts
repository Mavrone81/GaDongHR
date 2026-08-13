import {
  DEFAULT_MAX_RETRIES,
  LAST_ERROR_HEADER,
  ORIGINAL_TOPIC_HEADER,
  RETRY_COUNT_HEADER,
  decideRetry,
  readOriginalTopic,
  readRetryCount,
} from './retry'

describe('readRetryCount', () => {
  it('is 0 for a first delivery (no headers at all)', () => {
    expect(readRetryCount(undefined)).toBe(0)
  })

  it('is 0 when the header is absent', () => {
    expect(readRetryCount({})).toBe(0)
  })

  it('reads a prior numeric count', () => {
    expect(readRetryCount({ [RETRY_COUNT_HEADER]: 3 })).toBe(3)
  })

  it('fails open to 0 for a garbage header value, rather than throwing or going negative', () => {
    expect(readRetryCount({ [RETRY_COUNT_HEADER]: 'not-a-number' })).toBe(0)
    expect(readRetryCount({ [RETRY_COUNT_HEADER]: -4 })).toBe(0)
    expect(readRetryCount({ [RETRY_COUNT_HEADER]: Number.NaN })).toBe(0)
  })
})

describe('readOriginalTopic', () => {
  it('falls back to the routing key on a first delivery (no header yet)', () => {
    expect(readOriginalTopic(undefined, 'employee.created')).toBe('employee.created')
    expect(readOriginalTopic({}, 'employee.created')).toBe('employee.created')
  })

  it('prefers the stamped header over the routing key — this is the fix for a real bug: `ConsumerLoop` retries via `sendToQueue`, whose routing key on redelivery is the QUEUE name, not the original topic', () => {
    expect(readOriginalTopic({ [ORIGINAL_TOPIC_HEADER]: 'employee.created' }, 'q.svc-payroll.events')).toBe('employee.created')
  })

  it('ignores a non-string or empty header value', () => {
    expect(readOriginalTopic({ [ORIGINAL_TOPIC_HEADER]: 123 }, 'fallback.key')).toBe('fallback.key')
    expect(readOriginalTopic({ [ORIGINAL_TOPIC_HEADER]: '' }, 'fallback.key')).toBe('fallback.key')
  })
})

describe('decideRetry', () => {
  it('retries a first failure (attempt 1) when under the default max', () => {
    const decision = decideRetry(undefined, new Error('boom'), 'employee.created')
    expect(decision).toEqual({ attempt: 1, action: 'retry', headers: expect.objectContaining({ [RETRY_COUNT_HEADER]: 1 }) })
  })

  it('carries the failing error message forward as a header', () => {
    const decision = decideRetry(undefined, new Error('minimumWageNotOnFile'), 'employee.created')
    expect(decision.headers[LAST_ERROR_HEADER]).toBe('minimumWageNotOnFile')
  })

  it('stamps the topic so it survives a `sendToQueue` retry hop', () => {
    const decision = decideRetry(undefined, new Error('boom'), 'employee.created')
    expect(decision.headers[ORIGINAL_TOPIC_HEADER]).toBe('employee.created')
  })

  it('stringifies a non-Error throw rather than losing it', () => {
    const decision = decideRetry(undefined, 'plain string throw', 'employee.created')
    expect(decision.headers[LAST_ERROR_HEADER]).toBe('plain string throw')
  })

  it('keeps retrying up through the configured max', () => {
    let headers: Record<string, unknown> | undefined
    for (let i = 0; i < DEFAULT_MAX_RETRIES; i++) {
      const decision = decideRetry(headers, new Error('poison'), 'employee.created')
      expect(decision.action).toBe('retry')
      headers = decision.headers
    }
  })

  it('dead-letters once attempts exceed the configured max — this is the poison-message escape hatch', () => {
    const priorHeaders = { [RETRY_COUNT_HEADER]: DEFAULT_MAX_RETRIES }
    const decision = decideRetry(priorHeaders, new Error('still poisoned'), 'employee.created')
    expect(decision.action).toBe('dead-letter')
    expect(decision.attempt).toBe(DEFAULT_MAX_RETRIES + 1)
  })

  it('honours a custom maxRetries (0 = dead-letter on first failure)', () => {
    const decision = decideRetry(undefined, new Error('boom'), 'employee.created', 0)
    expect(decision.action).toBe('dead-letter')
    expect(decision.attempt).toBe(1)
  })

  it('preserves unrelated prior headers rather than replacing the whole header set', () => {
    const decision = decideRetry({ 'x-other': 'keep-me' }, new Error('boom'), 'employee.created')
    expect(decision.headers['x-other']).toBe('keep-me')
  })

  it('re-stamps the topic on every retry hop, unaffected by whatever the routing key of the requeued copy will be', () => {
    let headers: Record<string, unknown> | undefined
    for (let i = 0; i < 3; i++) {
      const decision = decideRetry(headers, new Error('poison'), 'employee.created')
      expect(decision.headers[ORIGINAL_TOPIC_HEADER]).toBe('employee.created')
      headers = decision.headers
    }
  })
})

import { HttpException } from '@nestjs/common'
import { GadongError } from '@gadong/kernel'

/** Shared by every business controller in this service — translates a thrown `GadongError` into the `{code, message_i18n_key, details}` envelope at its declared HTTP status, matching every sibling service's controller (`svc-onboarding`'s `EmployeeController.runFailClosed`). Anything else is a genuine bug and is left to propagate. */
export async function runFailClosed<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof GadongError) throw new HttpException(err.toEnvelope(), err.httpStatus)
    throw err
  }
}

export function runFailClosedSync<T>(fn: () => T): T {
  try {
    return fn()
  } catch (err) {
    if (err instanceof GadongError) throw new HttpException(err.toEnvelope(), err.httpStatus)
    throw err
  }
}

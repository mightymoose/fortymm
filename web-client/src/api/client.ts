import createClient from 'openapi-fetch'
import type { paths } from './schema'

export function resolveBaseUrl(): string {
  const explicit = import.meta.env.VITE_API_URL
  if (explicit) return explicit
  if (typeof window !== 'undefined' && window.location?.origin) {
    return `${window.location.origin}/api`
  }
  return 'http://localhost/api'
}

export const api = createClient<paths>({
  baseUrl: resolveBaseUrl(),
  fetch: (...args) => globalThis.fetch(...args),
})

/**
 * Info carried by the `session_merged` 401: the backend's human message and the
 * owning account's email (to prefill on the login screen).
 */
export interface SessionEndedInfo {
  message: string
  email?: string
}

let sessionEndedHandler: ((info: SessionEndedInfo) => void) | null = null
let sessionEndedFiring = false

/**
 * Register the global "your session was merged away" handler (set once at app
 * bootstrap). It fires from the response middleware below for *any* request, so
 * a guest whose account was merged on another device is sent to sign in no
 * matter which call surfaces it — not just the session bootstrap.
 */
export function setSessionEndedHandler(
  fn: ((info: SessionEndedInfo) => void) | null,
): void {
  sessionEndedHandler = fn
}

async function readSessionMerged(
  response: Response,
): Promise<SessionEndedInfo | null> {
  try {
    const body = (await response.clone().json()) as {
      detail?: { code?: unknown; message?: unknown; email?: unknown }
    }
    const detail = body?.detail
    if (
      detail &&
      typeof detail === 'object' &&
      detail.code === 'session_merged'
    ) {
      return {
        message:
          typeof detail.message === 'string'
            ? detail.message
            : 'Your session has ended. Sign in to continue.',
        email: typeof detail.email === 'string' ? detail.email : undefined,
      }
    }
  } catch {
    // Non-JSON / already-consumed body — not our structured 401.
  }
  return null
}

api.use({
  async onResponse({ response }) {
    // Reset the latch on any healthy response so a later genuine session-end
    // can fire again.
    if (response.ok) {
      sessionEndedFiring = false
    } else if (response.status === 401 && !sessionEndedFiring) {
      const info = await readSessionMerged(response)
      if (info) {
        // Latch so a burst of in-flight 401s triggers a single redirect.
        sessionEndedFiring = true
        sessionEndedHandler?.(info)
      }
    }
    return response
  },
})

export function extractDetail(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  const detail = (value as { detail?: unknown }).detail
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail) && detail.length > 0) {
    const first = detail[0]
    if (first && typeof first === 'object' && 'msg' in first) {
      return String((first as { msg: unknown }).msg)
    }
  }
  return null
}

/**
 * Thrown by `unwrap` for non-2xx responses. Carries the HTTP status so callers
 * can branch on it (e.g. surface a 409 inline on a form field instead of as a
 * toast). For network/decode failures with no response, status is 0.
 */
export class ApiError extends Error {
  readonly status: number
  readonly detail: string | null

  constructor(status: number, detail: string | null, label: string) {
    super(detail ?? `Failed to ${label}`)
    this.name = 'ApiError'
    this.status = status
    this.detail = detail
  }
}

/**
 * Throws ApiError when the openapi-fetch result has an error or no data. Pass
 * `{ allowEmpty: true }` for endpoints that legitimately return no body (e.g.
 * 204 DELETEs).
 */
export function unwrap<T>(
  label: string,
  result: { data?: T; error?: unknown; response?: Response },
  options: { allowEmpty?: boolean } = {},
): T {
  const { data, error, response } = result
  if (error) {
    throw new ApiError(response?.status ?? 0, extractDetail(error), label)
  }
  if (data === undefined && !options.allowEmpty) {
    throw new ApiError(response?.status ?? 0, null, label)
  }
  return data as T
}

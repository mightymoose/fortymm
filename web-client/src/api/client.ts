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

const CSRF_COOKIE_NAME = 'csrf_token'
const CSRF_HEADER_NAME = 'X-CSRF-Token'
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** Read a non-HttpOnly cookie value by name from `document.cookie`. */
function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null
  const prefix = `${name}=`
  for (const part of document.cookie.split('; ')) {
    if (part.startsWith(prefix)) {
      return decodeURIComponent(part.slice(prefix.length))
    }
  }
  return null
}

api.use({
  // Double-submit CSRF: echo the server-set `csrf_token` cookie back in a
  // header on every mutating request. The backend (app/main.py:csrf_protect)
  // 403s any unsafe-method request whose header doesn't match the cookie.
  onRequest({ request }) {
    if (!SAFE_METHODS.has(request.method.toUpperCase())) {
      const token = readCookie(CSRF_COOKIE_NAME)
      if (token) request.headers.set(CSRF_HEADER_NAME, token)
    }
    return request
  },
})

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

/**
 * True when `error` is the structured `session_merged` 401 — the user's guest
 * account was merged away on another device. The global response middleware
 * (`setSessionEndedHandler`) already handles this by redirecting to `/login`, so
 * UI error boundaries should defer to that redirect rather than show a generic
 * "something went wrong" screen (#672). A *bare* 401 (no `session_merged` code)
 * is not this case and should still surface normally.
 */
export function isSessionMergedError(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status !== 401) return false
  const detail = (error.body as { detail?: unknown } | null | undefined)?.detail
  return (
    !!detail &&
    typeof detail === 'object' &&
    (detail as { code?: unknown }).code === 'session_merged'
  )
}

export function extractDetail(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  const detail = (value as { detail?: unknown }).detail
  if (typeof detail === 'string') return detail
  // Structured error bodies (e.g. the score-write 409 conflict, which also
  // carries the committed score) put the human message under `detail.message`.
  if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
    const message = (detail as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  if (Array.isArray(detail) && detail.length > 0) {
    const first = detail[0]
    if (first && typeof first === 'object' && 'msg' in first) {
      // Pydantic v2 prefixes messages from a custom validator's `ValueError`
      // with a literal "Value error, " — internal machinery, not user copy.
      // Strip it so the rule message (e.g. the table-tennis score rules) reads
      // cleanly inline (#151). FastAPI uses the same prefix for every 422.
      return String((first as { msg: unknown }).msg).replace(/^Value error, /, '')
    }
  }
  return null
}

/**
 * Thrown by `unwrap` for non-2xx responses. Carries the HTTP status so callers
 * can branch on it (e.g. surface a 409 inline on a form field instead of as a
 * toast). For network/decode failures with no response, status is 0.
 *
 * `body` is the raw parsed error response body (e.g. `{ detail: ... }`), kept so
 * callers that need a *structured* detail — like the score-write 409 conflict,
 * which carries the committed score — can read it without re-fetching. `detail`
 * remains the human message extracted from it.
 */
export class ApiError extends Error {
  readonly status: number
  readonly detail: string | null
  readonly body: unknown

  constructor(status: number, detail: string | null, label: string, body?: unknown) {
    super(detail ?? `Failed to ${label}`)
    this.name = 'ApiError'
    this.status = status
    this.detail = detail
    this.body = body
  }
}

/**
 * The structured conflict detail when `error` is a score-write 409/412 whose
 * body carries `{ detail: { message, committed_score } }` — i.e. a genuine
 * concurrency conflict (a concurrent participant saved this game), as opposed to
 * a plain-string 409 (e.g. a locked match). Returns `null` for anything else, so
 * callers can tell the two apart instead of treating every 409 as a conflict.
 */
export function conflictDetail(
  error: ApiError,
): { message?: string; committed_score: unknown } | null {
  if (error.status !== 409 && error.status !== 412) return null
  const detail = (error.body as { detail?: unknown } | null | undefined)?.detail
  if (
    detail &&
    typeof detail === 'object' &&
    !Array.isArray(detail) &&
    'committed_score' in detail
  ) {
    return detail as { message?: string; committed_score: unknown }
  }
  return null
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
    throw new ApiError(response?.status ?? 0, extractDetail(error), label, error)
  }
  if (data === undefined && !options.allowEmpty) {
    throw new ApiError(response?.status ?? 0, null, label)
  }
  return data as T
}

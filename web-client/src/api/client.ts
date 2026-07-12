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
 * Info carried by a session-ended 401 (`session_merged` or `session_ended`): the
 * backend's human message, and — only for the merged case — the owning account's
 * email to prefill on the login screen.
 */
export interface SessionEndedInfo {
  message: string
  email?: string
}

let sessionEndedHandler: ((info: SessionEndedInfo) => void) | null = null
let sessionEndedFiring = false

/**
 * Register the global "your session ended" handler (set once at app bootstrap).
 * It fires from the response middleware below for *any* request, so a holder
 * whose session went away — merged on another device, or signed out / expired —
 * is sent to sign in no matter which call surfaces it, not just the session
 * bootstrap.
 */
export function setSessionEndedHandler(
  fn: ((info: SessionEndedInfo) => void) | null,
): void {
  sessionEndedHandler = fn
}

// The structured 401 `code`s that mean "this tab's session is gone — sign in":
// a guest merged away on another device (`session_merged`, carries the owner's
// email to prefill), or a signed-out/expired session (`session_ended`, no
// email). Any other 401 — a bare string, a different code — is an ordinary auth
// failure and must NOT trip the global sign-out, so we match on the code, never
// the bare status.
const SESSION_ENDED_CODES = new Set(['session_merged', 'session_ended'])

/** True when a 401's `detail` payload carries one of the session-ended codes.
 * Both the response-middleware reader and the `ApiError` classifier narrow the
 * same `unknown` body (from a live `Response` vs. a stored `ApiError`), so the
 * check lives here once. */
function hasSessionEndedCode(detail: unknown): boolean {
  if (!detail || typeof detail !== 'object') return false
  const code = (detail as { code?: unknown }).code
  return typeof code === 'string' && SESSION_ENDED_CODES.has(code)
}

async function readSessionEnded(
  response: Response,
): Promise<SessionEndedInfo | null> {
  try {
    const body = (await response.clone().json()) as {
      detail?: { code?: unknown; message?: unknown; email?: unknown }
    }
    const detail = body?.detail
    if (detail && hasSessionEndedCode(detail)) {
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

/** True once the double-submit CSRF cookie is readable — i.e. some request has
 * already completed the session bootstrap and the browser has a cookie jar to
 * show for it. */
export function hasCsrfCookie(): boolean {
  return readCookie(CSRF_COOKIE_NAME) !== null
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
      const info = await readSessionEnded(response)
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
 * True when `error` is a structured session-ended 401 — the guest was merged
 * away on another device (`session_merged`), or the session was signed out /
 * expired (`session_ended`). The global response middleware
 * (`setSessionEndedHandler`) already handles both by redirecting to `/login`, so
 * UI error boundaries should defer to that redirect rather than show a generic
 * "something went wrong" screen (#672). A *bare* 401 (no session-ended code) is
 * an ordinary auth failure and should still surface normally.
 */
export function isSessionEndedError(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status !== 401) return false
  const detail = (error.body as { detail?: unknown } | null | undefined)?.detail
  return hasSessionEndedCode(detail)
}

/** One entry of FastAPI's 422 body: `{"detail": [{"loc": ["body", "name"],
 * "msg": "String should have at most 255 characters"}, …]}`. */
interface PydanticError {
  loc: unknown[]
  msg: string
}

/**
 * The Pydantic errors carried by a FastAPI **request-validation** body, or `null`
 * when the body is not that shape (a plain-string `detail`, a coded object, no
 * body at all).
 *
 * The distinction is the point, and it is a distinction about the *shape*, not the
 * status: this array is the only error body whose `msg` is written by **Pydantic**
 * rather than by us. "String should have at most 255 characters" is machinery — it
 * names a type constraint, in the wire's vocabulary, and it must never be shown to
 * a user (`DEFINITION_OF_COMPLETE.md`: *"Raw API detail strings never reach the
 * UI"*; ADR-0968: the client owns its copy). What it *does* carry that no client
 * can guess is `loc` — **which field** the server refused — so this is the reader
 * for that, and `extractDetail` below stays the reader for the message.
 *
 * Callers therefore get to ask two separate questions of the same body: "did the
 * server send me machine prose?" (this) and "did the server send me a sentence we
 * wrote?" (`extractDetail`, whose string/`.message` arms are our own copy).
 */
function pydanticErrors(value: unknown): PydanticError[] | null {
  if (!value || typeof value !== 'object') return null
  const detail = (value as { detail?: unknown }).detail
  if (!Array.isArray(detail) || detail.length === 0) return null
  const errors = detail.filter(
    (entry): entry is PydanticError =>
      !!entry &&
      typeof entry === 'object' &&
      'msg' in entry &&
      typeof (entry as { msg: unknown }).msg === 'string',
  )
  return errors.length > 0 ? errors : null
}

/**
 * The FIELDS a request-validation body blames — `loc: ["body", "max_players"]`
 * yields `"max_players"` — or `null` when the error is not a Pydantic validation
 * body at all.
 *
 * `null` vs. `[]` is load-bearing: `null` means *"this refusal is not Pydantic's;
 * its `detail` is a sentence somebody wrote"*, while an empty array means *"it is
 * Pydantic's, and it named no field we can point at"*. A UI needs both — the first
 * decides whether the server's words are safe to show at all, the second whether it
 * can name the offending field in words of its own.
 *
 * Only the first `loc` segment after the `"body"` prefix is kept: `["body", "slot",
 * "start"]` is a complaint about the **Time slot** as far as a form is concerned,
 * and the leaf is the wire's business.
 */
export function validationFields(error: unknown): string[] | null {
  const body = error instanceof ApiError ? error.body : error
  const errors = pydanticErrors(body)
  if (!errors) return null

  const fields: string[] = []
  for (const { loc } of errors) {
    const path = loc.filter((part): part is string => typeof part === 'string')
    const field = path[0] === 'body' ? path[1] : path[0]
    if (field !== undefined && !fields.includes(field)) fields.push(field)
  }
  return fields
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
  const errors = pydanticErrors(value)
  if (errors) {
    // Pydantic v2 prefixes messages from a custom validator's `ValueError`
    // with a literal "Value error, " — internal machinery, not user copy.
    // Strip it so the rule message (e.g. the table-tennis score rules) reads
    // cleanly inline (#151). FastAPI uses the same prefix for every 422.
    return errors[0].msg.replace(/^Value error, /, '')
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
 * True when `error` is the propose-result NEGOTIATION conflict specifically —
 * the server's `_negotiation_conflict`, whose 409 body is the viewer-relative
 * negotiation OBJECT (`{ detail: { viewer_state, your_turn, standing_result … } }`).
 * That's the "a result already exists" case: a refetch reliably surfaces the
 * standing result, so score-entry can redirect the poster to match detail (#801).
 *
 * It deliberately does NOT match the other two propose 409s, whose `detail` is a
 * plain STRING: the lock race ("A result is already being posted…") and the
 * terminal guard ("This match is no longer open to results.") — those are
 * transient/plain errors the caller should keep surfacing with a live retry,
 * never a permanent redirect. Nor does it match the score-write `committed_score`
 * conflict object (that shape has no `viewer_state`), keeping the two object-body
 * 409s distinct.
 */
export function isNegotiationConflict(error: ApiError): boolean {
  if (error.status !== 409) return false
  const detail = (error.body as { detail?: unknown } | null | undefined)?.detail
  return (
    detail !== null &&
    typeof detail === 'object' &&
    !Array.isArray(detail) &&
    'viewer_state' in detail
  )
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

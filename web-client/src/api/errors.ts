// The API answered `request` without data. For a 429, `retryAt` is when its
// Retry-After header says to try again, or null without one. `title` is the
// first title of a body in the `errors` shape, or null for another body.
export class ApiError extends Error {
  readonly status: number
  readonly retryAt: Date | null
  readonly title: string | null

  constructor(request: string, response: Response, body?: unknown) {
    super(`${request} answered ${response.status}`)
    this.name = 'ApiError'
    this.status = response.status
    this.retryAt = parseRetryAfter(response.headers.get('Retry-After'))
    this.title = errorsTitle(body)
  }
}

function errorsTitle(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || !('errors' in body)) return null
  const [first] = Array.isArray(body.errors) ? body.errors : []
  return typeof first?.title === 'string' ? first.title : null
}

// The API never answered `request`: the device is offline, or the request
// failed before a response came back.
export class ApiUnreachable extends Error {
  constructor(request: string, options: ErrorOptions) {
    super(`${request} got no response`, options)
    this.name = 'ApiUnreachable'
  }
}

// Retry-After is either a number of seconds or an HTTP date.
function parseRetryAfter(value: string | null): Date | null {
  if (value === null) return null
  const seconds = Number(value)
  if (value.trim() !== '' && Number.isFinite(seconds)) {
    return new Date(Date.now() + seconds * 1000)
  }
  const date = Date.parse(value)
  return Number.isNaN(date) ? null : new Date(date)
}

// This browser has no signing key yet. It makes one once the API answers
// its session.
export class NoSigningKey extends Error {
  constructor() {
    super('this browser has no signing key')
    this.name = 'NoSigningKey'
  }
}

export type Failure =
  | { kind: 'unreachable' }
  | { kind: 'no-signing-key' }
  | { kind: 'rate-limited'; retryAt: Date | null }
  | { kind: 'broken' }

// The Worker answers 503 without an API origin, and Cloudflare answers 502
// or 504 when the API doesn't. Each means the API can't be reached.
const UNREACHABLE_STATUSES = new Set([502, 503, 504])

// What a failed request means for the visitor, so a page can say what to do.
export function classifyFailure(error: unknown): Failure {
  if (error instanceof ApiUnreachable) return { kind: 'unreachable' }
  if (error instanceof NoSigningKey) return { kind: 'no-signing-key' }
  if (error instanceof ApiError) {
    if (error.status === 429) return { kind: 'rate-limited', retryAt: error.retryAt }
    if (UNREACHABLE_STATUSES.has(error.status)) return { kind: 'unreachable' }
  }
  return { kind: 'broken' }
}

// What each failure tells the visitor: a title, then a sentence. ErrorPage
// and QueryBoundary both say it.
export const failureMessages: Record<Failure['kind'], { title: string; sentence: string }> = {
  unreachable: {
    title: 'Can’t reach FortyMM',
    sentence:
      'Our server isn’t answering. It may be starting up, or your connection may be down. Check your connection, then try again.',
  },
  'no-signing-key': {
    title: 'This browser can’t sign the result yet',
    sentence:
      'FortyMM makes this browser’s signing key once it reaches our server. Check your connection, then try again.',
  },
  'rate-limited': {
    title: 'Wait a minute, then try again',
    sentence:
      'Your network sent a lot of requests in a short time, so we paused it for a minute.',
  },
  broken: {
    title: 'Something went wrong',
    sentence:
      'FortyMM hit an error loading this page. Try again. If it keeps happening, tell us what you were doing.',
  },
}

// The API's titles for the refusals of a result that can mean "not yet":
// the result it replaces hasn't reached the API, or the key that signed it
// isn't registered yet. The API's errors carry no code to match instead.
export const STALE_RESULT = "The result doesn't replace the match's newest result"
export const UNKNOWN_KEY = "A signature's key isn't registered, or was revoked"

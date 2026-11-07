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

// What each of the API's refusals of a result means for the player who
// approved it, in plain words. The API's errors carry no code, so the
// titles are the keys, with any curly apostrophe read as a straight one.
const RESULT_REFUSALS: Record<string, string> = {
  "A signature's account doesn't play as or manage the player it signs for":
    'The approval came from an account that doesn’t play this match.',
  "A signature doesn't match the result": 'The scores were changed after they were sent. Ask for the link again.',
  [UNKNOWN_KEY]: 'FortyMM doesn’t know one of the phones this result came from. Ask for the link again.',
  [STALE_RESULT]: 'FortyMM has newer scores for this match. Ask for the latest link.',
  "Another result replaced this one, so it can't be approved":
    'Newer scores replaced these. Ask for the latest link.',
  "The scores aren't a legal ending to the match": 'These scores can’t end the match.',
  "Both sides of the match are now the same player": 'Both sides of this match are now the same player.',
  "The envelope isn't a FortyMM signed result": 'FortyMM can’t read this result.',
  'The result is for another match': 'This result is for another match.',
  'No match has this id': 'FortyMM has no record of this match.',
  "You don't have permission to do this": 'This account can’t send results to FortyMM yet.',
}

export function resultRefusal(title: string): string {
  return RESULT_REFUSALS[title.replaceAll('’', "'")] ?? 'Ask your opponent for the link again.'
}

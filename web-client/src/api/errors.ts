// The API answered `request` without data. For a 429, `retryAt` is when its
// Retry-After header says to try again, or null without one.
export class ApiError extends Error {
  readonly status: number
  readonly retryAt: Date | null

  constructor(request: string, response: Response) {
    super(`${request} answered ${response.status}`)
    this.name = 'ApiError'
    this.status = response.status
    this.retryAt = parseRetryAfter(response.headers.get('Retry-After'))
  }
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

export type Failure =
  | { kind: 'unreachable' }
  | { kind: 'rate-limited'; retryAt: Date | null }
  | { kind: 'broken' }

// The Worker answers 503 without an API origin, and Cloudflare answers 502
// or 504 when the API doesn't. Each means the API can't be reached.
const UNREACHABLE_STATUSES = new Set([502, 503, 504])

// What a failed request means for the visitor, so a page can say what to do.
export function classifyFailure(error: unknown): Failure {
  if (error instanceof ApiUnreachable) return { kind: 'unreachable' }
  if (error instanceof ApiError) {
    if (error.status === 429) return { kind: 'rate-limited', retryAt: error.retryAt }
    if (UNREACHABLE_STATUSES.has(error.status)) return { kind: 'unreachable' }
  }
  return { kind: 'broken' }
}

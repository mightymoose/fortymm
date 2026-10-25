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

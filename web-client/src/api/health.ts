import { api } from './client.ts'

// What the web client knows about the api's health: one of three answers.
// `unknown` covers every case where the api did not tell us either of the
// other two: it could not be reached, or it answered something the OpenAPI
// document doesn't declare (another status, or a body that isn't the
// document's).
export type Health =
  | { status: 'healthy' }
  | { status: 'database-unavailable' }
  | { status: 'unknown' }

// GET /v1/health, turned into a Health. Never throws.
export async function fetchHealth(): Promise<Health> {
  try {
    const { data, error, response } = await api.GET('/v1/health')
    // The optional chaining is for a body that doesn't match its type: the
    // types say what the api sends, not what every server on the way does.
    if (response.status === 200 && data?.data?.attributes?.database === 'ok') {
      return { status: 'healthy' }
    }
    if (
      response.status === 503 &&
      error?.errors?.some((e) => e.code === 'database_unavailable')
    ) {
      return { status: 'database-unavailable' }
    }
  } catch {
    // A network error, or a body that isn't JSON (openapi-fetch parses it).
  }
  return { status: 'unknown' }
}

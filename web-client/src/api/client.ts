import createClient from 'openapi-fetch'
// Generated from api/openapi.json by web-client:api-types. Never edit it.
import type { paths } from './schema.gen.ts'

// Where the api is, as the browser sees it: /api on the origin the app itself
// was served from. Whatever serves the app forwards /api/* to the api with the
// prefix stripped, so /api/v1/health reaches the api's /v1/health: Vite's
// proxy in dev (vite.config.ts), and the hosting, the Worker in
// web-client/worker/, when it was given an api (a pull request's preview
// is given its own; the production Worker none yet, so there /api/* is a
// 404). The paths in the generated types
// stay the api's own (/v1/health). The app's routes never start with /api.
export const apiBaseUrl = `${window.location.origin}/api`

// The one client every call to the api goes through. It types the request:
// calling a path, method or parameter the api's OpenAPI document doesn't have
// fails web-client:typecheck. It does not decide what came back.
export const api = createClient<paths>({
  baseUrl: apiBaseUrl,
  // Look fetch up on every call. openapi-fetch otherwise keeps the fetch that
  // existed when this module loaded, and MSW, which component tests use in
  // place of the api, replaces the global fetch later.
  fetch: (request) => globalThis.fetch(request),
})

// The body of an answer, whatever its status, as `unknown`. openapi-fetch
// types `data` and `error` from the document, but that is a promise about the
// api, not about every server on the way, so nothing reads them directly:
// a call parses the body with its zod schemas (bound to the document by
// fromWire in wire.ts), and only what matches one is trusted.
export function bodyOf(result: { data?: unknown; error?: unknown }): unknown {
  return result.data ?? result.error
}

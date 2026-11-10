import createClient from 'openapi-fetch'
// Generated from api/openapi.json by web-client:api-types. Never edit it.
import type { paths } from './schema.gen.ts'

// Where the api is, as the browser sees it: /api on the origin the app itself
// was served from. Whatever serves the app forwards /api/* to the api with the
// prefix stripped, so /api/v1/health reaches the api's /v1/health: Vite's
// proxy in dev (vite.config.ts), web-client-hosting's nginx in the cross-app
// suite, and the production hosting later. The paths in the generated types
// stay the api's own (/v1/health). The app's routes never start with /api.
export const apiBaseUrl = `${window.location.origin}/api`

// The one client every call to the api goes through. Paths, parameters and
// response bodies are typed from the api's OpenAPI document, so calling a path
// the document doesn't have, or reading a field it doesn't declare, fails
// web-client:typecheck.
export const api = createClient<paths>({
  baseUrl: apiBaseUrl,
  // Look fetch up on every call. openapi-fetch otherwise keeps the fetch that
  // existed when this module loaded, and MSW, which component tests use in
  // place of the api, replaces the global fetch later.
  fetch: (request) => globalThis.fetch(request),
})

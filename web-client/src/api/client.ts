import createClient from 'openapi-fetch'
// Generated from api/openapi.json by web-client:api-types. Never edit it.
import type { paths } from './schema.gen.ts'

// Where the api is, as the browser sees it: the origin the app itself was
// served from. The hosting in front of the app forwards /v1/* to the api.
export const apiBaseUrl = window.location.origin

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

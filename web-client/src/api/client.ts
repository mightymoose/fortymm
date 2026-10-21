import createClient, { type ClientOptions } from 'openapi-fetch'
import type { paths } from './schema'

// A fetch client for the FortyMM API, typed from its OpenAPI schema
// (`./schema.d.ts`, generated from api/openapi.json by `npm run
// generate:api`), e.g. `const { data } = await api.GET('/v1/ping')`.
//
// The API is served under /api: in development the Vite dev server proxies
// it to the `api` Compose service (see vite.config.ts).
export function createApiClient(options: ClientOptions = {}) {
  return createClient<paths>({ baseUrl: '/api', ...options })
}

export const api = createApiClient()

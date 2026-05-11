import createClient from 'openapi-fetch'
import type { paths } from './schema'

function resolveBaseUrl(): string {
  const explicit = import.meta.env.VITE_API_URL
  if (explicit) return explicit
  if (typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin
  }
  return 'http://localhost'
}

export const api = createClient<paths>({
  baseUrl: resolveBaseUrl(),
  fetch: (...args) => globalThis.fetch(...args),
})

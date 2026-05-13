import createClient from 'openapi-fetch'
import type { paths } from './schema'

function resolveBaseUrl(): string {
  const explicit = import.meta.env.VITE_API_URL
  if (explicit) return explicit
  if (typeof window !== 'undefined' && window.location?.origin) {
    return `${window.location.origin}/api`
  }
  return 'http://localhost/api'
}

export const api = createClient<paths>({
  baseUrl: resolveBaseUrl(),
  fetch: (...args) => globalThis.fetch(...args),
})

export function extractDetail(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  const detail = (value as { detail?: unknown }).detail
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail) && detail.length > 0) {
    const first = detail[0]
    if (first && typeof first === 'object' && 'msg' in first) {
      return String((first as { msg: unknown }).msg)
    }
  }
  return null
}

/**
 * Throws Error(detail || `Failed to ${label}`) when the openapi-fetch result has
 * an error or no data. Pass `{ allowEmpty: true }` for endpoints that legitimately
 * return no body (e.g. 204 DELETEs).
 */
export function unwrap<T>(
  label: string,
  result: { data?: T; error?: unknown },
  options: { allowEmpty?: boolean } = {},
): T {
  const { data, error } = result
  if (error) {
    throw new Error(extractDetail(error) ?? `Failed to ${label}`)
  }
  if (data === undefined && !options.allowEmpty) {
    throw new Error(`Failed to ${label}`)
  }
  return data as T
}

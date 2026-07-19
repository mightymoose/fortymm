// The **API-token** boundary: where `POST /v1/api-tokens` stops being bytes off
// the wire and becomes a typed domain value — the one-time raw token the
// Administration area's API-token page reveals.
//
// Why a Zod parse and not just the generated types: `schema.d.ts` is a
// compile-time claim, the network is untrusted
// (`.claude/rules/parse-at-boundaries.md`), and the whole page hangs on the
// single `token` string being present and non-empty — an empty or missing token
// must fail HERE, inside the mutation, not render as a "copy this" panel showing
// nothing.

import { useMutation } from '@tanstack/react-query'
import { z } from 'zod'

import { api, unwrap } from './client'

const apiTokenCreatedSchema = z.object({
  token: z.string().min(1),
})

/** The freshly minted raw token, returned exactly once. */
type ApiTokenCreated = z.infer<typeof apiTokenCreatedSchema>

/**
 * Mint (or **rotate**) the caller's personal opaque API token. The server
 * revokes any existing token for the user and returns the new raw token exactly
 * once — it is never shown again and cannot be recovered, so the page must treat
 * it like a password. Gated server-side on `api_token.manage`.
 *
 * No cache to seed or invalidate: the API exposes only this POST (no
 * GET/DELETE), so the raw token lives in the page's own state for the life of
 * the reveal and nowhere else.
 */
export function useCreateApiToken() {
  return useMutation({
    mutationFn: async (): Promise<ApiTokenCreated> =>
      apiTokenCreatedSchema.parse(
        unwrap('create an API token', await api.POST('/v1/api-tokens', {})),
      ),
  })
}

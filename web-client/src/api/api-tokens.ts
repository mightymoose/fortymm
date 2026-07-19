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
import type { components } from './schema'

type ApiTokenCreatedWire = components['schemas']['ApiTokenCreated']

/** The freshly minted raw token, returned exactly once. */
export interface ApiTokenCreated {
  token: string
}

const apiTokenCreatedSchema = z.object({
  token: z.string().min(1),
})

// Compile-time tether: the runtime parser must accept exactly what the generated
// type says the server sends. Drop or misspell `token` on either side and this
// line is a type error.
const _wireParity: ApiTokenCreatedWire extends z.input<
  typeof apiTokenCreatedSchema
>
  ? true
  : never = true
void _wireParity

/** Parse the mint endpoint's payload, or throw. `unknown` on purpose — the
 * generated type is exactly the claim this checks. */
export function parseApiTokenCreated(input: unknown): ApiTokenCreated {
  return apiTokenCreatedSchema.parse(input)
}

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
      parseApiTokenCreated(
        unwrap('create an API token', await api.POST('/v1/api-tokens', {})),
      ),
  })
}

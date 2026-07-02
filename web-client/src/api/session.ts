import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { ApiError, api, unwrap } from './client'
import { clearAppEntered } from '@/lib/landing-redirect'
import type { components } from './schema'

export type Session = components['schemas']['SessionResponse']
export type SessionUser = components['schemas']['SessionUser']

export const SESSION_QUERY_KEY = ['session'] as const

export function sessionQueryOptions() {
  return queryOptions({
    queryKey: SESSION_QUERY_KEY,
    queryFn: async (): Promise<Session> =>
      unwrap('load session', await api.GET('/v1/session')),
    staleTime: 1000 * 60 * 5,
    // Don't retry a 401 (session merged away): the 401 already cleared the
    // cookie, so a retry would silently mint a *new* guest and race the
    // redirect-to-login. Transient errors still retry.
    retry: (failureCount, error) =>
      !(error instanceof ApiError && error.status === 401) && failureCount < 3,
  })
}

export function useSession() {
  return useQuery(sessionQueryOptions())
}

export type EmailStatus = 'guest' | 'pending' | 'verified'

export function deriveEmailStatus({
  email,
  confirmedAt,
  pendingEmail,
}: {
  email: string | null
  confirmedAt: string | null
  pendingEmail: string | null
}): EmailStatus {
  // A pending change wins even when the user is already verified — the FE
  // still has something to nudge them to complete.
  if (pendingEmail) return 'pending'
  if (confirmedAt) return 'verified'
  if (email) return 'pending'
  return 'guest'
}

/** True when the current session carries `name` in its permissions list. */
export function useHasPermission(name: string): boolean {
  const { data } = useSession()
  return data?.data.user.permissions.includes(name) ?? false
}

// Callers that want inline 4xx error handling (e.g. ChangeUsernameDialog)
// must await this via mutateAsync and catch ApiError themselves.
export function useUpdateUsername() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (username: string): Promise<Session> =>
      unwrap(
        'update username',
        await api.PATCH('/v1/me', { body: { username } }),
      ),
    onSuccess: (session) => {
      qc.setQueryData(SESSION_QUERY_KEY, session)
    },
  })
}

export interface SetEmailInput {
  email: string
  captchaToken: string
  // Honeypot — the form must include this field on the wire even when
  // empty so the server's bot-check semantics match the FE form shape.
  honeypot?: string
}

export function useSetEmail() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({
      email,
      captchaToken,
      honeypot = '',
    }: SetEmailInput): Promise<Session> =>
      unwrap(
        'set email',
        await api.POST('/v1/me/email', {
          body: {
            email,
            captcha_token: captchaToken,
            fmm_hp_token: honeypot,
          },
        }),
      ),
    onSuccess: (session) => {
      qc.setQueryData(SESSION_QUERY_KEY, session)
    },
  })
}

export function useResendEmailConfirmation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({
      captchaToken,
      honeypot = '',
    }: {
      captchaToken: string
      honeypot?: string
    }): Promise<Session> =>
      unwrap(
        'resend confirmation',
        await api.POST('/v1/me/email/resend', {
          body: { captcha_token: captchaToken, fmm_hp_token: honeypot },
        }),
      ),
    onSuccess: (session) => {
      qc.setQueryData(SESSION_QUERY_KEY, session)
    },
  })
}

export type MergePreview = components['schemas']['MergePreview']

/** Side-effect-free look at an emailed link, to decide whether to show the
 * "bring N matches over?" gate before finalizing. */
export function useMergePreview() {
  return useMutation({
    mutationFn: async (token: string): Promise<MergePreview> =>
      unwrap('check link', await api.POST('/v1/merge/preview', { body: { token } })),
  })
}

/** Input for the finalize mutations. `skipMerge` is the gate's "not now": sign
 * in without folding the guest's matches in. */
export interface FinalizeTokenInput {
  token: string
  skipMerge?: boolean
}

export function useConfirmEmail() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({
      token,
      skipMerge = false,
    }: FinalizeTokenInput): Promise<Session> =>
      unwrap(
        'confirm email',
        await api.POST('/v1/me/email/confirm', {
          body: { token, skip_merge: skipMerge },
        }),
      ),
    // This can sign the caller into a *different* existing account
    // (skip_merge). Drop the prior identity's cached per-user data first — the
    // same leak useLogout guards against (#754) — then reseed the session so
    // it doesn't need a refetch.
    onSuccess: (session) => {
      qc.clear()
      qc.setQueryData(SESSION_QUERY_KEY, session)
    },
  })
}

export interface RequestLoginInput {
  email: string
  captchaToken: string
  honeypot?: string
}

export function useRequestLogin() {
  return useMutation({
    mutationFn: async ({
      email,
      captchaToken,
      honeypot = '',
    }: RequestLoginInput) =>
      unwrap(
        'request sign-in link',
        await api.POST('/v1/login/request', {
          body: {
            email,
            captcha_token: captchaToken,
            fmm_hp_token: honeypot,
          },
        }),
      ),
  })
}

export function useLogout() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (): Promise<void> => {
      unwrap('sign out', await api.DELETE('/v1/session'), { allowEmpty: true })
    },
    // Drop ALL cached per-user data (matches, dashboard, players, ...), not
    // just SESSION_QUERY_KEY — otherwise the prior user's BFF responses leak
    // into the next ephemeral session.
    onSuccess: () => {
      qc.clear()
      clearAppEntered()
    },
  })
}

export function useConsumeLoginToken() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({
      token,
      skipMerge = false,
    }: FinalizeTokenInput): Promise<Session> =>
      unwrap(
        'sign in',
        await api.POST('/v1/login/consume', {
          body: { token, skip_merge: skipMerge },
        }),
      ),
    // Same identity-leak guard as useConfirmEmail (#754): this can sign a
    // browsing guest into a different existing account.
    onSuccess: (session) => {
      qc.clear()
      qc.setQueryData(SESSION_QUERY_KEY, session)
    },
  })
}

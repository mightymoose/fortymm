import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { api, unwrap } from './client'
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
  })
}

export function useSession() {
  return useQuery(sessionQueryOptions())
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

export function useConfirmEmail() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (token: string): Promise<Session> =>
      unwrap(
        'confirm email',
        await api.POST('/v1/me/email/confirm', { body: { token } }),
      ),
    onSuccess: (session) => {
      qc.setQueryData(SESSION_QUERY_KEY, session)
    },
  })
}

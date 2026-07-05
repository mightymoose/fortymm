import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { toast } from 'sonner'
import { ApiError, api, hasCsrfCookie, unwrap } from './client'
import { clearAppEntered } from '@/lib/landing-redirect'
import type { components } from './schema'

export type Session = components['schemas']['SessionResponse']
export type SessionUser = components['schemas']['SessionUser']

export const SESSION_QUERY_KEY = ['session'] as const

// TanStack Query only single-flights `/v1/session` within one tab's
// QueryClient. Several cold tabs opened at once each have their own
// QueryClient, so each fires its own request before the browser has a
// `session` cookie, and each mints its own guest — the last `Set-Cookie` wins
// and the other tabs are left holding a stale identity (#824). This lock
// widens the singleflight to the whole origin for the one race that matters:
// the cold bootstrap. Once a `csrf_token` cookie is readable, a session
// already exists, so later calls skip the lock entirely.
const SESSION_LOCK_NAME = 'fortymm:session-bootstrap'
const SESSION_LOCK_STORAGE_KEY = 'fortymm:session-bootstrap:lock'
const SESSION_LOCK_TTL_MS = 10_000
const SESSION_LOCK_POLL_MS = 50

interface StorageLockRecord {
  owner: string
  expires: number
}

function readStorageLock(): StorageLockRecord | null {
  const raw = localStorage.getItem(SESSION_LOCK_STORAGE_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as StorageLockRecord
  } catch {
    return null
  }
}

// Fallback single-flight for browsers without the Web Locks API. localStorage
// writes aren't atomic across tabs, so this can't guarantee mutual exclusion
// the way `navigator.locks` does — but it narrows the race window to
// milliseconds, and the TTL means a tab that crashes mid-bootstrap can never
// wedge the others (they just wait out the TTL and proceed).
async function withStorageLock<T>(fn: () => Promise<T>): Promise<T> {
  const owner = `${Date.now()}-${Math.random()}`
  const deadline = Date.now() + SESSION_LOCK_TTL_MS
  for (;;) {
    const held = readStorageLock()
    if (!held || held.expires < Date.now()) {
      localStorage.setItem(
        SESSION_LOCK_STORAGE_KEY,
        JSON.stringify({ owner, expires: Date.now() + SESSION_LOCK_TTL_MS }),
      )
      // Yield a tick, then re-read: narrows (but can't eliminate) the window
      // where two tabs both saw no lock and both wrote.
      await new Promise((resolve) => setTimeout(resolve, 0))
      if (readStorageLock()?.owner === owner) break
    }
    if (Date.now() > deadline) break
    if (hasCsrfCookie()) return fn()
    await new Promise((resolve) => setTimeout(resolve, SESSION_LOCK_POLL_MS))
  }
  try {
    return await fn()
  } finally {
    if (readStorageLock()?.owner === owner) {
      localStorage.removeItem(SESSION_LOCK_STORAGE_KEY)
    }
  }
}

/** Single-flights the `/v1/session` cold-bootstrap request across every tab
 * on the origin, not just within one TanStack QueryClient. */
async function withSessionBootstrapLock<T>(fn: () => Promise<T>): Promise<T> {
  // A session already exists — no mint race to guard against.
  if (hasCsrfCookie()) return fn()
  if (typeof navigator !== 'undefined' && navigator.locks?.request) {
    return navigator.locks.request(SESSION_LOCK_NAME, () => fn())
  }
  if (typeof localStorage === 'undefined') return fn()
  return withStorageLock(fn)
}

export function sessionQueryOptions() {
  return queryOptions({
    queryKey: SESSION_QUERY_KEY,
    queryFn: (): Promise<Session> =>
      withSessionBootstrapLock(async () =>
        unwrap('load session', await api.GET('/v1/session')),
      ),
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
      // Announce carried-over matches here, in the once-per-result mutation
      // lifecycle, rather than in a component `useEffect` — StrictMode
      // double-invokes effects on mount, which fired this toast twice (#233).
      announceMergedMatches(session)
    },
  })
}

/**
 * Toast the "we carried your matches over" confirmation after a merge-capable
 * finalize (email confirm or login-token consume). Single source of the
 * singular/plural copy so the #241 grammar guard lives in one place, not two.
 */
export function announceMergedMatches(session: Session): void {
  const moved = session.merged?.matches_moved ?? 0
  if (moved > 0) {
    toast.success(
      moved === 1
        ? 'We brought your 1 match with you.'
        : `We brought your ${moved} matches with you.`,
    )
  }
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

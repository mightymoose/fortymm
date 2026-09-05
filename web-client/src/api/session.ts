import {
  type QueryClient,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { z } from 'zod'
import { ApiError, api, hasCsrfCookie, restoreCsrfCompanion, unwrap } from './client'
import { handleIdentityChange } from './identity-change'
import { announceIdentityChange, forgetSessionEnd, readEndedSession, rememberSessionEnd, synchronizeSessionEnd } from './browser-session'
import { closeRealtimeConnections } from './realtime/connection'
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

// The lock record is persisted client state (localStorage), so it's untrusted
// on read — a different app version, a manual edit, or a truncated write could
// leave anything there. Parse it at the boundary instead of casting the
// `JSON.parse` result (see `.claude/rules/parse-at-boundaries.md`); a shape
// mismatch is treated as "no lock", exactly like a parse/JSON error.
const storageLockSchema = z.object({
  owner: z.string(),
  expires: z.number(),
})
type StorageLockRecord = z.infer<typeof storageLockSchema>

export function readStorageLock(): StorageLockRecord | null {
  const raw = localStorage.getItem(SESSION_LOCK_STORAGE_KEY)
  if (!raw) return null
  try {
    const parsed = storageLockSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

// Fallback single-flight for browsers without the Web Locks API. localStorage
// writes aren't atomic across tabs, so this can't guarantee mutual exclusion
// the way `navigator.locks` does — but it narrows the race window to
// milliseconds, and the TTL means a tab that crashes mid-bootstrap can never
// wedge the others (they just wait out the TTL and proceed).
async function withStorageLock<T>(fn: () => Promise<T>, alwaysLock = false, requireStorage = alwaysLock): Promise<T> {
  const owner = `${Date.now()}-${Math.random()}`
  const deadline = Date.now() + SESSION_LOCK_TTL_MS
  for (;;) {
    try {
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
    } catch {
      // Destructive recovery needs cross-tab exclusion; an in-tab queue
      // cannot safely replace it when the shared backend is unavailable.
      if (requireStorage) throw new Error('Session recovery is unavailable. Please enable browser storage and try again.')
      return fn()
    }
    if (Date.now() > deadline) throw new Error('Another tab is updating your session. Please try again.')
    if (!alwaysLock && hasCsrfCookie()) return fn()
    await new Promise((resolve) => setTimeout(resolve, SESSION_LOCK_POLL_MS))
  }
  // Renew while the request is pending: a slow network response must not
  // turn an active recovery into an expired lock that another tab can take.
  const renewal = setInterval(() => {
    try {
      if (readStorageLock()?.owner === owner) {
        localStorage.setItem(SESSION_LOCK_STORAGE_KEY,
          JSON.stringify({ owner, expires: Date.now() + SESSION_LOCK_TTL_MS }))
      }
    } catch { clearInterval(renewal) }
  }, SESSION_LOCK_TTL_MS / 3)
  try {
    return await fn()
  } finally {
    clearInterval(renewal)
    try {
      if (readStorageLock()?.owner === owner) localStorage.removeItem(SESSION_LOCK_STORAGE_KEY)
    } catch { /* Storage became unavailable during the request. */ }
  }
}

let localSessionQueue: Promise<unknown> = Promise.resolve()
function withLocalSessionLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = localSessionQueue.then(fn, fn)
  localSessionQueue = result.catch(() => undefined)
  return result
}

/** Single-flights the `/v1/session` cold-bootstrap request across every tab
 * on the origin, not just within one TanStack QueryClient. */
async function withSessionBootstrapLock<T>(fn: () => Promise<T>, mode: 'bootstrap' | 'recovery' | 'logout' = 'bootstrap'): Promise<T> {
  const alwaysLock = mode !== 'bootstrap'
  // A session already exists — no mint race to guard against.
  if (!alwaysLock && hasCsrfCookie()) return fn()
  const run = () => {
    if (mode === 'recovery') synchronizeSessionEnd()
    if (mode === 'logout') {
      // Refresh stale retry state when possible, but storage failures must
      // never prevent revocation of the current server-side credential.
      try { synchronizeSessionEnd() } catch { /* Revocation remains available. */ }
    }
    return fn()
  }
  if (typeof navigator !== 'undefined' && navigator.locks?.request) {
    return navigator.locks.request(SESSION_LOCK_NAME, run)
  }
  return withLocalSessionLock(() => withStorageLock(run, alwaysLock, mode === 'recovery'))
}

export function sessionQueryOptions() {
  return queryOptions({
    queryKey: SESSION_QUERY_KEY,
    queryFn: (): Promise<Session> =>
      withSessionBootstrapLock(async () => {
        const ended = readEndedSession()
        if (ended) {
          throw new ApiError(401, ended.message, 'load session', {
            detail: { code: 'session_ended', ...ended },
          })
        }
        return unwrap('load session', await api.GET('/v1/session'))
      }),
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

const accountSwitchSchema = z.object({
  from_user_id: z.string(),
  from_username: z.string(),
  to_username: z.string(),
})
const mergePreviewSchema = z.object({
  is_merge: z.boolean(),
  owner_username: z.string().nullable().optional(),
  guest_username: z.string().nullable().optional(),
  guest_matches_count: z.number().int().nonnegative().default(0),
  adopts_guest_username: z.boolean().default(false),
  account_switch: accountSwitchSchema.nullable().optional(),
})

/** Side-effect-free look at an emailed link, to decide whether to show the
 * "bring N matches over?" gate before finalizing. */
export function useMergePreview() {
  return useMutation({
    mutationFn: async (token: string): Promise<MergePreview> =>
      mergePreviewSchema.parse(
        unwrap('check link', await api.POST('/v1/merge/preview', { body: { token } })),
      ),
  })
}

/** Input for the finalize mutations. `skipMerge` is the gate's "not now": sign
 * in without folding the guest's matches in. */
export interface FinalizeTokenInput {
  token: string
  skipMerge?: boolean
  switchFromUserId?: string
}

/** Seed `SESSION_QUERY_KEY` from a sign-in/confirm response. `GET /v1/session`
 * never returns `merged` — strip it before caching so a future
 * `useSession().data.merged` read can't see this mutation's stale value for
 * the full 5-minute staleTime (#239). */
function cacheSession(qc: QueryClient, session: Session): void {
  qc.setQueryData(SESSION_QUERY_KEY, { ...session, merged: null })
}

async function afterPendingLogout<T>(fn: () => Promise<T>): Promise<T> {
  if (!readEndedSession()?.logoutPending) return fn()
  return withSessionBootstrapLock(async () => {
    if (readEndedSession()?.logoutPending) {
      restoreCsrfCompanion()
      unwrap('finish sign out', await api.DELETE('/v1/session'), { allowEmpty: true })
      rememberSessionEnd({ message: 'You have signed out. Sign in to continue.', logoutPending: false }, { notifyLocal: false })
    }
    return fn()
  }, 'recovery')
}

export function useConfirmEmail() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({
      token,
      skipMerge = false,
      switchFromUserId,
    }: FinalizeTokenInput): Promise<Session> =>
      afterPendingLogout(async () => unwrap(
        'confirm email',
        await api.POST('/v1/me/email/confirm', {
          body: { token, skip_merge: skipMerge, switch_from_user_id: switchFromUserId },
        }),
      )),
    // This can sign the caller into a *different* existing account
    // (skip_merge). Drop the prior identity's cached per-user data first — the
    // same leak useLogout guards against (#754) — then reseed the session so
    // it doesn't need a refetch. `clearAppEntered` is deliberately NOT part of
    // it: this browser is arriving, not leaving.
    onSuccess: (session) => {
      handleIdentityChange({
        closeRealtime: closeRealtimeConnections,
        clearQueryCache: () => qc.clear(),
      })
      cacheSession(qc, session)
      forgetSessionEnd()
      announceIdentityChange()
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

export function useLogout(retryOnly = false) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (): Promise<void> => withSessionBootstrapLock(async () => {
      if (retryOnly && !readEndedSession()?.logoutPending) return
      restoreCsrfCompanion()
      rememberSessionEnd({ message: 'Sign-out is not complete. Retry to finish signing out.', logoutPending: true })
      unwrap('sign out', await api.DELETE('/v1/session'), { allowEmpty: true })
      if (readEndedSession()?.logoutPending) {
        rememberSessionEnd({ message: 'You have signed out. Sign in to continue.', logoutPending: false })
      }
    }, 'logout'),
    // Drop ALL cached per-user data (matches, dashboard, players, ...), not
    // just SESSION_QUERY_KEY — otherwise the prior user's BFF responses leak
    // into the next ephemeral session.
    //
    // Through the shared sequence, not inline: this is the path MOST exposed to
    // the ordering hazard, because it always fires from inside `_app` with a
    // live `/v1/stream` open (the user menu and the settings footer). The
    // caller owns the navigation that follows, so no `navigateToLogin` here.
    onSuccess: () => {
      if (readEndedSession()?.logoutPending !== false) return
      handleIdentityChange({
        closeRealtime: closeRealtimeConnections,
        clearAppEntered,
        clearQueryCache: () => qc.clear(),
      })
    },
  })
}

export function useConsumeLoginToken() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({
      token,
      skipMerge = false,
      switchFromUserId,
    }: FinalizeTokenInput): Promise<Session> =>
      afterPendingLogout(async () => unwrap(
        'sign in',
        await api.POST('/v1/login/consume', {
          body: { token, skip_merge: skipMerge, switch_from_user_id: switchFromUserId },
        }),
      )),
    // Same identity-leak guard as useConfirmEmail (#754): this can sign a
    // browsing guest into a different existing account.
    onSuccess: (session) => {
      handleIdentityChange({
        closeRealtime: closeRealtimeConnections,
        clearQueryCache: () => qc.clear(),
      })
      cacheSession(qc, session)
      forgetSessionEnd()
      announceIdentityChange()
    },
  })
}

// The bare address auth mail really sends from (`GET /v1/login/sender`), for
// the `/login/sent` receipt row (#1466 defect 1). Static, deployment-wide,
// takes no input and reads no cookie — so unlike `useSession` it's safe to
// call from a bookmarked `/login/sent` without minting a guest.
export const LOGIN_SENDER_QUERY_KEY = ['login-sender'] as const

const loginSenderResponseSchema = z.object({ address: z.string().nullable() })

export function loginSenderQueryOptions() {
  return queryOptions({
    queryKey: LOGIN_SENDER_QUERY_KEY,
    // The Zod parse is still the runtime boundary guarantee
    // (`.claude/rules/parse-at-boundaries.md`) even though `api.GET` now
    // types this path from the regenerated `schema.d.ts` — a type
    // annotation is a compile-time claim, not a runtime check.
    queryFn: async (): Promise<string | null> => {
      const body = unwrap('load sign-in sender', await api.GET('/v1/login/sender'))
      return loginSenderResponseSchema.parse(body).address
    },
    // A single constant for the whole deployment (Settings.email_from) — it
    // cannot change mid-session, so there's nothing to ever refetch for.
    staleTime: Infinity,
    retry: false,
  })
}

/** The bare sender address, or `undefined` while loading/on failure — callers
 * must render fine either way (see `EmailReceipt`'s optional `sender` prop):
 * this is receipt trivia, never something worth blocking `/login/sent` on. */
export function useLoginSender() {
  return useQuery(loginSenderQueryOptions())
}

/** An explicit choice to abandon the ended session and start a separate guest. */
export function useStartNewGuest() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (): Promise<Session> => withSessionBootstrapLock(async () => {
      // A preceding recovery in another tab may already have replaced the
      // ended session. Reuse that identity instead of deleting it again.
      if (readEndedSession()) {
        restoreCsrfCompanion()
        unwrap('clear old session', await api.DELETE('/v1/session'), { allowEmpty: true })
      }
      const session = unwrap('start a new guest', await api.GET('/v1/session'))
      // Publish completion before releasing the origin-wide lock.
      forgetSessionEnd()
      announceIdentityChange()
      return session
    }, 'recovery'),
    onSuccess: (session) => {
      handleIdentityChange({
        closeRealtime: closeRealtimeConnections,
        clearQueryCache: () => qc.clear(),
      })
      cacheSession(qc, session)
    },
  })
}

const switchConflictSchema = z.object({
  detail: z.object({
    code: z.literal('account_switch_required'),
    account_switch: accountSwitchSchema.nullable(),
  }),
})

export function accountSwitchConflict(error: unknown) {
  if (!(error instanceof ApiError) || error.status !== 409) return null
  const result = switchConflictSchema.safeParse(error.body)
  return result.success ? result.data.detail : null
}

import { useEffect, useRef, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'
import { z } from 'zod'

import { ApiError } from '@/api/client'
import {
  accountSwitchConflict,
  type MergePreview,
  useConsumeLoginToken,
  useMergePreview,
} from '@/api/session'
import { btnGhost, btnPrimary, fineprint } from '@/components/login/styles'
import { LinkCheckPage } from '@/components/login/link-check-page/link-check-page'
import { ScreenVerifyNetError } from '@/components/login/login-screens'
import { AccountSwitchGate, ReviewAccountSwitch } from '@/components/login/account-switch-gate'
import { MergeGate } from '@/components/login/merge-gate'
import { pageTitle } from '@/lib/page-title'

// The screens this route can be sent to by `?error=`. The tuple is the single
// source of the type AND of the URL parse, so the two cannot drift.
const VERIFY_ERRORS = ['expired', 'net', 'replaced', 'email_changed'] as const
type VerifyError = (typeof VERIFY_ERRORS)[number]
// `.catch(undefined)` so a hand-typed `?error=garbage` falls through to the
// normal verifying flow instead of throwing at the route boundary.
const verifyErrorSchema = z.enum(VERIFY_ERRORS).optional().catch(undefined)

// `POST /v1/login/consume`'s 400 body, `{ detail: { code, message } }` —
// `consume_login_token`'s three coded reasons (#1466 defect 3). NOT declared
// on the route's OpenAPI `responses=` (matches the existing
// `session_merged`/`session_ended` precedent in client.ts), so it never
// reaches `schema.d.ts` — read off `ApiError.body`, never off the typed
// `ApiError.detail` (a bare `string | null`), and parse it here.
//
// Shaped after `components/tournaments/data/entry-refusal.ts` (ADR-0968): the
// tuple is the single source of the code type, and `message` is deliberately
// not read — a code we recognise is a code we already have a screen for, so
// the server's sentence never reaches the UI.
const LOGIN_CONSUME_ERROR_CODES = [
  'invalid_or_expired',
  'email_changed',
  'replaced',
] as const
type LoginConsumeErrorCode = (typeof LOGIN_CONSUME_ERROR_CODES)[number]

const loginConsumeErrorSchema = z.object({
  detail: z.object({ code: z.enum(LOGIN_CONSUME_ERROR_CODES) }),
})

/** The structured `code` a 4xx from `/login/consume` carries, or `null` when
 * the body doesn't parse as the coded shape (a plain-string detail, no body,
 * or a code this client has no screen for). `null` maps to the safe
 * `'expired'` fallback — today's behaviour for every other 4xx. */
function loginConsumeErrorCode(err: unknown): LoginConsumeErrorCode | null {
  if (!(err instanceof ApiError)) return null
  const parsed = loginConsumeErrorSchema.safeParse(err.body)
  return parsed.success ? parsed.data.detail.code : null
}

/** Which screen each server code reaches. Two types with a table between them,
 * on purpose: `VerifyError` also carries `'net'`, which no API code produces,
 * and the API's `invalid_or_expired` is this client's `'expired'`. Exhaustive
 * over `LoginConsumeErrorCode`, so a fourth code added to `sessions.py` is a
 * compile error here rather than a silent mis-route back to `'expired'` — the
 * exact collapse #1466 defect 3 exists to undo. */
const CODE_TO_VERIFY_ERROR: Record<LoginConsumeErrorCode, VerifyError> = {
  invalid_or_expired: 'expired',
  email_changed: 'email_changed',
  replaced: 'replaced',
}

export const Route = createFileRoute('/login/verifying')({
  head: () => ({
    meta: [{ title: pageTitle('Verifying') }],
  }),
  validateSearch: (search: Record<string, unknown>) => {
    const e = search.error
    // A duplicated `?token=a&token=b` is parsed into an array. Take the first
    // value so the dedup case behaves like a single (likely-invalid) token and
    // surfaces the generic invalid-link error, not a misleading "missing token".
    const raw = Array.isArray(search.token) ? search.token[0] : search.token
    return {
      token: typeof raw === 'string' ? raw : '',
      error: verifyErrorSchema.parse(e),
    }
  },
  component: LoginVerifyingPage,
})

function LoginVerifyingPage() {
  const { token, error } = Route.useSearch()
  const navigate = useNavigate()
  const preview = useMergePreview()
  const consume = useConsumeLoginToken()
  // Holds the preview only while the cross-device gate is up; everything else
  // (previewing, consuming) renders the same verifying screen.
  const [gate, setGate] = useState<MergePreview | null>(null)
  const fired = useRef(false)
  const [approvedSwitch, setApprovedSwitch] = useState<string | undefined>()

  const runConsume = (skipMerge: boolean, switchFromUserId = approvedSwitch) => {
    setGate(null)
    consume.mutate(
      { token, skipMerge, switchFromUserId },
      {
        onSuccess: (session) => {
          const moved = session.merged?.matches_moved ?? 0
          if (moved > 0) {
            toast.success(
              moved === 1
                ? 'We brought your 1 match with you.'
                : `We brought your ${moved} matches with you.`,
            )
          }
          navigate({ to: '/login/welcome' })
        },
        onError: (err) => {
          if (accountSwitchConflict(err)) return
          if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
            const code = loginConsumeErrorCode(err)
            const nextError: VerifyError =
              code === null ? 'expired' : CODE_TO_VERIFY_ERROR[code]
            navigate({
              to: '/login/verifying',
              search: { token: '', error: nextError },
            })
          } else {
            navigate({ to: '/login/verifying', search: { token, error: 'net' } })
          }
        },
      },
    )
  }

  // Preview first; a merge that would carry matches over waits at the gate,
  // everything else signs in straight away. We don't cancel from cleanup so
  // StrictMode's simulated unmount can't strand an in-flight request.
  useEffect(() => {
    if (fired.current || !token || error) return
    fired.current = true
    preview.mutate(token, {
      onSuccess: (p) => {
        if (p.account_switch || (p.is_merge && p.guest_matches_count > 0)) {
          setGate(p)
        } else {
          runConsume(false)
        }
      },
      onError: () => runConsume(false),
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, error])

  const sendNewLink = () =>
    navigate({ to: '/login', search: { error: undefined, email: undefined } })

  const sendNewLinkButton = (
    <button
      type="button"
      style={{ ...btnPrimary, width: '100%' }}
      onClick={sendNewLink}
    >
      Send a new link
    </button>
  )

  // The `replaced` state's screen must NOT offer "Send a new link" as its
  // main action — that would kill the newer link the copy just told the user
  // to open (#1466 defect 3, acceptance criteria). Guidance text plus a
  // demoted secondary action instead of the primary CTA every other error
  // state uses.
  const replacedFooter = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <p style={{ ...fineprint, textAlign: 'center', marginTop: 0 }}>
        Look for the most recent sign-in email — that link is still live.
      </p>
      <button
        type="button"
        style={{ ...btnGhost, width: '100%' }}
        onClick={sendNewLink}
      >
        Send a new link instead
      </button>
    </div>
  )

  if (!token && !error) {
    return <LinkCheckPage state="missing" footer={sendNewLinkButton} />
  }

  if (error === 'expired') {
    return <LinkCheckPage state="expired" footer={sendNewLinkButton} />
  }

  if (error === 'email_changed') {
    return <LinkCheckPage state="email_changed" footer={sendNewLinkButton} />
  }

  if (error === 'replaced') {
    return <LinkCheckPage state="replaced" footer={replacedFooter} />
  }

  if (error === 'net') {
    return (
      <ScreenVerifyNetError
        retrying={consume.isPending}
        onRetry={() => {
          fired.current = false
          setGate(null)
          navigate({ to: '/login/verifying', search: { token, error: undefined } })
        }}
        onSendNewLink={() =>
          navigate({ to: '/login', search: { error: undefined, email: undefined } })
        }
      />
    )
  }

  const conflict = accountSwitchConflict(consume.error)
  if (conflict) {
    const change = conflict.account_switch
    const cancel = () => navigate({ to: '/dashboard', replace: true })
    return change
      ? <AccountSwitchGate fromUsername={change.from_username} toUsername={change.to_username}
          onCancel={cancel} onContinue={() => runConsume(consume.variables?.skipMerge ?? false, change.from_user_id)} />
      : <ReviewAccountSwitch onCancel={cancel} onReview={() => {
          consume.reset()
          setApprovedSwitch(undefined)
          preview.mutate(token, { onSuccess: (p) => {
            if (p.account_switch || (p.is_merge && p.guest_matches_count > 0)) setGate(p)
            else runConsume(false)
          } })
        }} />
  }

  if (gate?.account_switch && !approvedSwitch) {
    const change = gate.account_switch
    return <AccountSwitchGate fromUsername={change.from_username} toUsername={change.to_username}
      onCancel={() => navigate({ to: '/dashboard', replace: true })}
      onContinue={() => {
        setApprovedSwitch(change.from_user_id)
        if (!(gate.is_merge && gate.guest_matches_count > 0)) runConsume(false, change.from_user_id)
      }} />
  }
  if (gate) {
    return (
      <MergeGate
        ownerUsername={gate.owner_username ?? ''}
        guestUsername={gate.guest_username ?? null}
        matchesCount={gate.guest_matches_count}
        adoptsGuestUsername={gate.adopts_guest_username}
        busy={consume.isPending}
        onBringThemOver={() => runConsume(false)}
        onNotNow={() => runConsume(true)}
      />
    )
  }

  return <LinkCheckPage state="checking" />
}

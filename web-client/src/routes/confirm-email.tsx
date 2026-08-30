import { useEffect, useRef } from 'react'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'
import { z } from 'zod'

import { ApiError } from '@/api/client'
import {
  type FinalizeTokenInput,
  type Session,
  useConfirmEmail,
  useMergePreview,
} from '@/api/session'
import { btnGhost, btnPrimary, fineprint } from '@/components/login/styles'
import {
  LinkCheckPage,
  type LinkCheckState,
} from '@/components/login/link-check-page/link-check-page'
import { MergeGate } from '@/components/login/merge-gate'
import { pageTitle } from '@/lib/page-title'

export const Route = createFileRoute('/confirm-email')({
  head: () => ({
    meta: [{ title: pageTitle('Confirm email') }],
  }),
  validateSearch: (search: Record<string, unknown>) => {
    // A duplicated `?token=a&token=b` is parsed into an array. Take the first
    // value so the dedup case behaves like a single (likely-invalid) token and
    // surfaces the generic invalid-link error, not a misleading "missing token".
    const raw = Array.isArray(search.token) ? search.token[0] : search.token
    return {
      token: typeof raw === 'string' ? raw : '',
    }
  },
  component: ConfirmEmailPage,
})

// Confirmation copy for every state this page renders. `LinkCheckPage`'s
// defaults are written for the *sign-in* flow (15-minute links, "you'll be
// straight in") — wrong for a confirmation link, which lasts 24 hours
// (`EMAIL_CONFIRM_TOKEN_LIFETIME`) and signs nobody in, so every state
// supplies its own wording (#1616). `email_changed` is absent on purpose:
// the nearest confirm branch stays opaque, so the page can never name it.
const CONFIRM_COPY: Partial<
  Record<LinkCheckState, { eyebrow: string; title: string; subtitle: string }>
> = {
  success: {
    eyebrow: '● Email confirmed',
    title: 'You’re in.',
    subtitle: 'Your email is verified — your FortyMM account is yours to keep.',
  },
  checking: {
    eyebrow: '● Confirming your email',
    title: 'Confirming your email',
    subtitle: 'Hang tight — this only takes a second.',
  },
  expired: {
    // Covers genuinely expired, already-used, and never-valid links.
    eyebrow: '● Link expired',
    title: "This link can't be used",
    subtitle:
      'Confirmation links last 24 hours and work once. Send a fresh one from Settings and try again.',
  },
  missing: {
    // Distinct from `expired`: the link arrived without its token at all
    // (often truncated when copied), so "expired or already used" is wrong.
    eyebrow: '● Link incomplete',
    title: 'This link is incomplete',
    subtitle:
      'This confirmation link is missing its token — it may have been cut off when it was copied. Open the most recent email in full, or send a fresh one from Settings.',
  },
  replaced: {
    // Distinct from `expired`: this link is dead because a LATER resend
    // replaced it, not because time ran out — sending yet another new link
    // isn't the fix, opening the one already sent is (#1616).
    eyebrow: '● Newer link sent',
    title: 'A newer link was sent',
    subtitle:
      'A newer confirmation link was requested for this address, so this one is no longer live. Open the most recent email we sent you.',
  },
}

// `POST /v1/me/email/confirm`'s 400 body for a superseded link,
// `{ detail: { code, message } }` (#1616) — NOT declared on the route's
// OpenAPI `responses=` (matches the login-consume precedent), so it never
// reaches `schema.d.ts` — read it off `ApiError.body`, never off the typed
// `ApiError.detail` (a bare `string | null`), and parse it here. Shaped after
// `login.verifying.tsx` (#1466): a code this client has no screen for, a
// plain-string detail (every other dead confirmation link), or no body fails
// the parse and falls through to the generic invalid/expired screen.
const CONFIRM_ERROR_CODES = ['replaced'] as const
type ConfirmErrorCode = (typeof CONFIRM_ERROR_CODES)[number]

const confirmErrorSchema = z.object({
  detail: z.object({ code: z.enum(CONFIRM_ERROR_CODES) }),
})

/** The structured `code` a 4xx from `/v1/me/email/confirm` carries, or
 * `null` when the body doesn't parse as the coded shape. */
function confirmErrorCode(err: unknown): ConfirmErrorCode | null {
  if (!(err instanceof ApiError)) return null
  const parsed = confirmErrorSchema.safeParse(err.body)
  return parsed.success ? parsed.data.detail.code : null
}

function ConfirmEmailPage() {
  const { token } = Route.useSearch()
  const navigate = useNavigate()
  const preview = useMergePreview()
  const confirm = useConfirmEmail()
  const fired = useRef(false)

  // Fires after any successful confirm, passed as every call site's
  // mutate-level onSuccess below. A mutate's onSuccess runs exactly once per
  // call by construction, so — unlike a useEffect keyed on isSuccess/data —
  // it needs no once-guard ref to survive a second invocation (e.g. React
  // StrictMode's double-render) (#233).
  const showMergeToast = (session: Session) => {
    const moved = session.merged?.matches_moved ?? 0
    if (moved > 0) {
      toast.success(
        moved === 1
          ? 'We brought your 1 match with you.'
          : `We brought your ${moved} matches with you.`,
      )
    }
  }

  // Every confirm this page ever fires wants the toast wired the same way —
  // wrap it once so the mutate-level `onSuccess` doesn't repeat at each call
  // site.
  const confirmWithToast = (input: FinalizeTokenInput) =>
    confirm.mutate(input, { onSuccess: showMergeToast })

  // Preview the link first. A merge that would carry matches over waits for the
  // user at the gate; everything else (plain confirm, empty guest, or a preview
  // failure) finalizes straight away.
  useEffect(() => {
    if (fired.current || !token) return
    fired.current = true
    preview.mutate(token, {
      onSuccess: (p) => {
        if (!(p.is_merge && p.guest_matches_count > 0)) {
          confirmWithToast({ token })
        }
      },
      onError: () => confirmWithToast({ token }),
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, preview, confirm])

  // The token is a single-use bearer credential. Once the confirm settles,
  // drop it from the URL so it doesn't linger in the address bar / history /
  // Referer — mirroring how `/login/verifying` scrubs its token (#521). The
  // displayed state is driven by the mutation result, not the search param, so
  // clearing `token` here doesn't revert the page to "missing token".
  useEffect(() => {
    if ((confirm.isSuccess || confirm.isError) && token) {
      navigate({ to: '/confirm-email', search: { token: '' }, replace: true })
    }
  }, [confirm.isSuccess, confirm.isError, token, navigate])

  const p = preview.data
  const showGate =
    confirm.status === 'idle' && !!p && p.is_merge && p.guest_matches_count > 0

  // Order matters: the confirm result wins over `!token`, because we scrub the
  // token from the URL after the mutation settles (#521) — a cleared token on
  // a settled mutation is "ok"/"error", not "missing-token". A genuine
  // no-token visit falls through to "missing-token".
  const status: 'missing-token' | 'gate' | 'confirming' | 'ok' | 'error' =
    confirm.isSuccess
      ? 'ok'
      : confirm.isError
        ? 'error'
        : showGate
          ? 'gate'
          : !token
            ? 'missing-token'
            : 'confirming'

  if (status === 'gate' && p) {
    return (
      <MergeGate
        ownerUsername={p.owner_username ?? ''}
        guestUsername={p.guest_username ?? null}
        matchesCount={p.guest_matches_count}
        adoptsGuestUsername={p.adopts_guest_username}
        busy={confirm.isPending}
        onBringThemOver={() => confirmWithToast({ token })}
        onNotNow={() => confirmWithToast({ token, skipMerge: true })}
      />
    )
  }

  // The `replaced` screen must NOT put a resend-shaped action up front —
  // "Back to settings" leads at Resend, and resending now would kill the
  // newer link the copy just told the user to open (#1466 precedent, #1616
  // acceptance criteria). Guidance text first, demoted secondary action
  // instead of the primary CTA every other error state uses.
  const replacedFooter = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <p style={{ ...fineprint, textAlign: 'center', marginTop: 0 }}>
        Look for the most recent confirmation email — that link is still live.
      </p>
      <Link to="/settings" hash="sec-email" style={{ ...btnGhost, width: '100%' }}>
        Back to settings
      </Link>
    </div>
  )

  // The five `LinkCheckPage` states this page maps onto (the merge gate above
  // is a separate render path). A coded `replaced` 4xx reaches its own
  // screen; every other failure — plain-string 4xx, network error, anything
  // unparsed — stays on the generic invalid/expired screen.
  const linkState: LinkCheckState =
    status === 'ok'
      ? 'success'
      : status === 'confirming'
        ? 'checking'
        : status === 'missing-token'
          ? 'missing'
          : status === 'error' && confirmErrorCode(confirm.error) === 'replaced'
            ? 'replaced'
            : 'expired'

  // Each failure state's reason is stated once, in its own subtitle — the
  // API's sentence is deliberately not repeated under it (#1616).
  const copy = CONFIRM_COPY[linkState]

  // Intentionally NOT wrapped in <AppShell> — AppShell calls useSession()
  // on mount, and `GET /v1/session` auto-mints a guest for cookieless
  // requests. Clicking the link on a device that doesn't share cookies
  // with the requesting browser (mobile mail, in-app webview) would leak
  // one orphan user + session-token row per click. The confirm endpoint
  // itself rotates the cookie to the token's owner, so the user lands on
  // the dashboard signed in as themselves.
  return (
    <LinkCheckPage
      state={linkState}
      eyebrow={copy?.eyebrow}
      title={copy?.title}
      subtitle={copy?.subtitle}
      footer={
        linkState === 'success' ? (
          <Link to="/dashboard" style={{ ...btnPrimary, width: '100%' }}>
            Go to dashboard
          </Link>
        ) : linkState === 'replaced' ? (
          replacedFooter
        ) : linkState === 'expired' || linkState === 'missing' ? (
          <Link
            to="/settings"
            hash="sec-email"
            style={{ ...btnPrimary, width: '100%' }}
          >
            Back to settings
          </Link>
        ) : undefined
      }
    />
  )
}

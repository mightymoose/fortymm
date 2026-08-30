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
    // isn't the fix, opening the one already sent is (#1616). Deliberately
    // does NOT say "for this address": the newer link goes to whatever
    // address was pending when it was requested, which a second change may
    // have moved — so it only claims a newer link exists.
    eyebrow: '● Newer link sent',
    title: 'A newer link was sent',
    subtitle:
      'A newer confirmation link was requested, so this one is no longer live. Open the most recent email we sent you — it may be for a different address.',
  },
  error: {
    // Distinct from `expired`: nothing here claims the link was rejected —
    // the request never got a real answer (transport failure or 5xx), so
    // resending would replace a link that is probably still live.
    eyebrow: '● Connection trouble',
    title: "We couldn't check this link",
    subtitle:
      "The server didn't answer, so this link went unused. It's usually still good — try again in a moment.",
  },
}

// `POST /v1/me/email/confirm`'s 400 body for a superseded link,
// `{ detail: { code, message } }` (#1616) — declared on the route's OpenAPI
// `responses=` as `ConfirmEmailErrorResponse`, but read off `ApiError.body`
// (the raw response body) and parsed here rather than trusted: the same
// status also carries the plain-string detail of every other dead link,
// which the declared model does not describe. Shaped after
// `login.verifying.tsx` (#1466): a code this client has no screen for, a
// plain-string detail, or no body fails the parse and falls through to the
// generic invalid/expired screen.
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

/** Whether `err` is a 4xx that actually rejects the token — the only kind of
 * failure whose copy may say the link is unusable. A transport failure or a
 * server-side 5xx answers nothing about the token, so it must not land on
 * the expired screen and its "send a fresh one" advice (#1616). */
function isRejectedConfirmError(err: unknown): boolean {
  return err instanceof ApiError && err.status >= 400 && err.status < 500
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

  // The token is scrubbed from the URL once the mutation settles (#521), but
  // a transient failure keeps its retry button on screen — remember the exact
  // input that attempt carried so "Try again" can replay it whole. Retaining
  // only the token would drop `skipMerge`, so a retried "Not now" would
  // default it back to false and merge the guest data the user explicitly
  // declined (#1616).
  const firedInput = useRef<FinalizeTokenInput | null>(null)

  // Every confirm this page ever fires wants the toast wired the same way —
  // wrap it once so the mutate-level `onSuccess` doesn't repeat at each call
  // site. Recording the input here — the one choke point every confirm passes
  // through — keeps the retained copy identical to the real attempt.
  const confirmWithToast = (input: FinalizeTokenInput) => {
    firedInput.current = input
    confirm.mutate(input, { onSuccess: showMergeToast })
  }

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
  // a settled mutation is "ok"/"error", not "missing-token". A tokenless
  // moment that still holds a retained input is a retry, not a fresh visit:
  // rendering "link incomplete" while confirmation is actively running would
  // hide the retry control and offer a misleading route back to Settings
  // (#1616). A genuine no-token visit has no retained input and falls through
  // to "missing-token".
  const status: 'missing-token' | 'gate' | 'confirming' | 'ok' | 'error' =
    confirm.isSuccess
      ? 'ok'
      : confirm.isError
        ? 'error'
        : showGate
          ? 'gate'
          : !token && firedInput.current === null
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

  // The `error` screen's one action is the retry: the request never answered
  // the question "is this token good?", so the link is probably still live
  // and a resend would replace it (#1616). The retry replays the whole input
  // the failed attempt carried — `skipMerge` included.
  const errorFooter = (
    <button
      type="button"
      style={{ ...btnPrimary, width: '100%' }}
      onClick={() => {
        const input = firedInput.current
        if (input !== null) confirmWithToast(input)
      }}
    >
      Try again
    </button>
  )

  // The six `LinkCheckPage` states this page maps onto (the merge gate above
  // is a separate render path). A coded `replaced` 4xx reaches its own screen;
  // any other 4xx is a genuine rejection and lands on the invalid/expired
  // screen; a transport failure or 5xx answers nothing about the token, so it
  // gets the retryable `error` screen instead of the "send a fresh one" copy
  // that would push the user into replacing a probably-live link (#1616).
  const linkState: LinkCheckState =
    status === 'ok'
      ? 'success'
      : status === 'confirming'
        ? 'checking'
        : status === 'missing-token'
          ? 'missing'
          : confirmErrorCode(confirm.error) === 'replaced'
            ? 'replaced'
            : isRejectedConfirmError(confirm.error)
              ? 'expired'
              : 'error'

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
        ) : linkState === 'error' ? (
          errorFooter
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

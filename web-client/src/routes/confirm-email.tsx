import { useQueryClient } from '@tanstack/react-query'
import { handleIdentityChange } from '@/api/identity-change'
import { closeRealtimeConnections } from '@/api/realtime/connection'
import { useEffect, useRef, useState } from 'react'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'
import { z } from 'zod'

import { ApiError } from '@/api/client'
import {
  accountSwitchConflict,
  type FinalizeTokenInput,
  type Session,
  useConfirmEmail,
  useMergePreview,
  SessionChangedError,
} from '@/api/session'
import { btnGhost, btnPrimary } from '@/components/login/styles'
import {
  LinkCheckPage,
  type LinkCheckState,
} from '@/components/login/link-check-page/link-check-page'
import { AccountSwitchGate, ReviewAccountSwitch } from '@/components/login/account-switch-gate'
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
// (`EMAIL_CONFIRM_TOKEN_LIFETIME`) and also signs the browser in, so every state
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

const confirmErrorSchema = z.object({
  detail: z.object({ code: z.string(), message: z.string().optional() }),
})

function confirmErrorDetail(err: unknown) {
  if (!(err instanceof ApiError)) return null
  const parsed = confirmErrorSchema.safeParse(err.body)
  return parsed.success ? parsed.data.detail : null
}

// Only a bad-request response declares the bearer dead. Conflicts and
// temporary limits leave it usable after the underlying problem is resolved.
function isRejectedConfirmError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 400
}

function ConfirmEmailPage() {
  const { token } = Route.useSearch()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const cancelSwitch = () => {
    handleIdentityChange({
      closeRealtime: closeRealtimeConnections,
      clearQueryCache: () => queryClient.clear(),
    })
    void navigate({ to: '/dashboard', replace: true })
  }
  const preview = useMergePreview()
  const confirm = useConfirmEmail()
  const fired = useRef(false)
  const [retryUntil, setRetryUntil] = useState<number | null>(null)
  useEffect(() => {
    if (retryUntil === null) return
    const timer = window.setTimeout(
      () => setRetryUntil(null),
      Math.min(Math.max(0, retryUntil - Date.now()), 2_147_483_647),
    )
    return () => window.clearTimeout(timer)
  }, [retryUntil])
  const [approvedSwitch, setApprovedSwitch] = useState<string | undefined>()

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
  const confirming = useRef(false)
  const [skipMerge, setSkipMerge] = useState(false)
  const confirmWithToast = (input: FinalizeTokenInput) => {
    if (confirming.current || (retryUntil !== null && retryUntil > Date.now())) return
    setRetryUntil(null)
    confirming.current = true
    setSkipMerge(input.skipMerge ?? false)
    firedInput.current = input
    confirm.mutate(input, { onSuccess: showMergeToast, onError: (error) => {
      if (error instanceof ApiError) setRetryUntil(error.retryAt)
      if (error instanceof SessionChangedError) void navigate({ to: '/dashboard', replace: true })
    }, onSettled: () => { confirming.current = false } })
  }

  // Preview the link first. A merge that would carry matches over waits for the
  // user at the gate; everything else (plain confirm, empty guest, or a preview
  // failure) finalizes straight away.
  useEffect(() => {
    if (fired.current || !token) return
    fired.current = true
    preview.mutate(token, {
      onSuccess: (p) => {
        if (!p.account_switch && !(p.is_merge && p.guest_matches_count > 0 && !firedInput.current?.skipMerge)) {
          confirmWithToast({ token, skipMerge: firedInput.current?.skipMerge ?? false })
        }
      },
      onError: () => confirmWithToast({ token, skipMerge: firedInput.current?.skipMerge ?? false }),
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, preview, confirm])

  // The token is a single-use bearer credential. Once the confirm settles,
  // drop it from the URL so it doesn't linger in the address bar / history /
  // Referer — mirroring how `/login/verifying` scrubs its token (#521). The
  // displayed state is driven by the mutation result, not the search param, so
  // clearing `token` here doesn't revert the page to "missing token".
  useEffect(() => {
    if (confirm.error instanceof SessionChangedError) {
      void navigate({ to: '/dashboard', replace: true })
      return
    }
    if ((confirm.isSuccess || (confirm.isError && !accountSwitchConflict(confirm.error))) && token) {
      navigate({ to: '/confirm-email', search: { token: '' }, replace: true })
    }
  }, [confirm.isSuccess, confirm.isError, confirm.error, token, navigate])

  const conflict = accountSwitchConflict(confirm.error)
  if (conflict) {
    const change = conflict.account_switch
    return change
      ? <AccountSwitchGate fromUsername={change.from_username} toUsername={change.to_username}
          onCancel={cancelSwitch}
          onContinue={() => confirmWithToast({ ...firedInput.current!, switchFromUserId: change.from_user_id })} />
      : <ReviewAccountSwitch onCancel={cancelSwitch} onReview={() => {
          fired.current = false
          setApprovedSwitch(undefined)
          confirm.reset()
          preview.reset()
        }} />
  }

  const p = preview.data
  if (confirm.isIdle && p?.account_switch && !approvedSwitch) {
    const change = p.account_switch
    return <AccountSwitchGate fromUsername={change.from_username} toUsername={change.to_username}
      onCancel={cancelSwitch}
      onContinue={() => {
        setApprovedSwitch(change.from_user_id)
        if (!(p.is_merge && p.guest_matches_count > 0 && !firedInput.current?.skipMerge)) {
          confirmWithToast({ token, skipMerge: firedInput.current?.skipMerge ?? false, switchFromUserId: change.from_user_id })
        }
      }} />
  }
  const showGate =
    confirm.status === 'idle' && !!p && p.is_merge && p.guest_matches_count > 0 && !skipMerge

  // Order matters: the confirm result wins over `!token`, because we scrub the
  // token from the URL after the mutation settles (#521) — a cleared token on
  // a settled mutation is "ok"/"error", not "missing-token". A tokenless
  // moment whose confirm has already fired is a retry, not a fresh visit:
  // rendering "link incomplete" while confirmation is actively running would
  // hide the retry control and offer a misleading route back to Settings
  // (#1616). A genuine no-token visit never fires a confirm, so the mutation
  // is still idle and it falls through to "missing-token". Read that from the
  // mutation's own reactive status, never from the `firedInput` ref — a ref
  // read during render does not re-render when it changes, so the screen
  // could keep the state it computed before the retry fired.
  const status: 'missing-token' | 'gate' | 'confirming' | 'ok' | 'error' =
    confirm.isSuccess
      ? 'ok'
      : confirm.isError
        ? 'error'
        : showGate
          ? 'gate'
          : !token && confirm.isIdle
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
        onBringThemOver={() => confirmWithToast({ token, switchFromUserId: approvedSwitch })}
        onNotNow={() => confirmWithToast({ token, skipMerge: true, switchFromUserId: approvedSwitch })}
      />
    )
  }

  // The `replaced` screen must NOT put a resend-shaped action up front —
  // "Back to settings" leads at Resend, and resending now would kill the
  // newer link the copy just told the user to open (#1466 precedent, #1616
  // acceptance criteria). So the route is present but demoted to a ghost
  // action, never the primary CTA every other error state uses. It carries no
  // guidance line of its own: the subtitle already says to open the most
  // recent email, and saying it twice is the exact duplication this ticket
  // set out to remove (#1616).
  const replacedFooter = (
    <Link to="/settings" hash="sec-email" style={{ ...btnGhost, width: '100%' }}>
      Back to settings
    </Link>
  )

  // The `error` screen's one action is the retry: the request never answered
  // the question "is this token good?", so the link is probably still live
  // and a resend would replace it (#1616). The retry replays the whole input
  // the failed attempt carried — `skipMerge` included.
  const errorFooter = (
    <button
      type="button"
      disabled={retryUntil !== null}
      style={{ ...btnPrimary, width: '100%' }}
      onClick={() => {
        const input = firedInput.current
        if (input !== null) confirmWithToast(input)
      }}
    >
      {retryUntil !== null ? 'Please wait before retrying' : 'Try again'}
    </button>
  )

  // The six `LinkCheckPage` states this page maps onto (the merge gate above
  // is a separate render path). A coded `replaced` 4xx reaches its own screen;
  // a 400 rejection lands on the invalid/expired
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
          : confirmErrorDetail(confirm.error)?.code === 'replaced'
            ? 'replaced'
            : isRejectedConfirmError(confirm.error)
              ? 'expired'
              : 'error'

  // Each failure state's reason is stated once, in its own subtitle — the
  // API's sentence is deliberately not repeated under it (#1616).
  const detail = confirmErrorDetail(confirm.error)
  const entryConflict = confirm.error instanceof ApiError
    && confirm.error.status === 409 && detail?.code === 'entry_merge_conflict'
  const temporarilyUnavailable = confirm.error instanceof ApiError
    && [429, 503].includes(confirm.error.status) ? confirm.error : null
  const copy = entryConflict
    ? {
        eyebrow: '● Tournament entry conflict',
        title: 'Your entries need attention',
        subtitle: detail?.message ?? 'Ask the tournament director to resolve the entry conflict, then try this confirmation again.',
      }
    : linkState === 'error' && temporarilyUnavailable
      ? {
          eyebrow: '● Please wait',
          title: 'Confirmation is temporarily unavailable',
          subtitle: temporarilyUnavailable.detail ?? detail?.message ?? 'Please wait a moment, then try this confirmation again.',
        }
      : linkState === 'success'
        ? { ...CONFIRM_COPY.success, subtitle: `You're now signed in as ${confirm.data?.data.user.username}. Your email is verified.` }
        : CONFIRM_COPY[linkState]

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
      pillCode={linkState === 'error' && confirm.error instanceof ApiError && confirm.error.status > 0
        ? String(confirm.error.status) : undefined}
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

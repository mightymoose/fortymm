import { useEffect, useRef } from 'react'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'

import { ApiError } from '@/api/client'
import {
  type FinalizeTokenInput,
  type Session,
  useConfirmEmail,
  useMergePreview,
} from '@/api/session'
import { btnPrimary } from '@/components/login/styles'
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

  const errorMsg =
    status === 'missing-token'
      ? 'This link is missing its token.'
      : confirm.error instanceof ApiError && confirm.error.detail
        ? confirm.error.detail
        : 'Confirmation failed.'

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

  // Intentionally NOT wrapped in <AppShell> — AppShell calls useSession()
  // on mount, and `GET /v1/session` auto-mints a guest user for cookieless
  // requests. Clicking the link on a device that doesn't share cookies
  // with the requesting browser (mobile mail, in-app webview) would leak
  // one orphan user + session-token row per click. The confirm endpoint
  // itself rotates the cookie to the token's owner, so the user lands on
  // the dashboard signed in as themselves.
  const linkState: LinkCheckState =
    status === 'ok' ? 'success' : status === 'confirming' ? 'checking' : 'expired'

  // Email-confirm copy per state; `expired` falls through to LinkCheckPage's
  // own defaults.
  const copy = CONFIRM_COPY[linkState]

  return (
    <LinkCheckPage
      state={linkState}
      eyebrow={copy?.eyebrow}
      title={copy?.title}
      subtitle={copy?.subtitle}
      detail={linkState === 'expired' ? errorMsg : undefined}
      footer={
        linkState === 'success' ? (
          <Link to="/dashboard" style={{ ...btnPrimary, width: '100%' }}>
            Go to dashboard
          </Link>
        ) : linkState === 'expired' ? (
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

import { useEffect, useRef, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'

import { ApiError } from '@/api/client'
import {
  type MergePreview,
  useConsumeLoginToken,
  useMergePreview,
} from '@/api/session'
import { btnPrimary } from '@/components/login/styles'
import { LinkCheckPage } from '@/components/login/link-check-page/link-check-page'
import { ScreenVerifyNetError } from '@/components/login/login-screens'
import { MergeGate } from '@/components/login/merge-gate'
import { pageTitle } from '@/lib/page-title'

type VerifyError = 'expired' | 'net'

export const Route = createFileRoute('/login/verifying')({
  head: () => ({
    meta: [{ title: pageTitle('Verifying') }],
  }),
  validateSearch: (search: Record<string, unknown>) => {
    const e = search.error
    return {
      token: typeof search.token === 'string' ? search.token : '',
      error: e === 'expired' || e === 'net' ? (e as VerifyError) : undefined,
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

  const runConsume = (skipMerge: boolean) => {
    setGate(null)
    consume.mutate(
      { token, skipMerge },
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
          if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
            navigate({
              to: '/login/verifying',
              search: { token: '', error: 'expired' },
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
        if (p.is_merge && p.guest_matches_count > 0) {
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

  if (!token && !error) {
    return (
      <LinkCheckPage
        state="expired"
        detail="This link is missing its token."
        footer={sendNewLinkButton}
      />
    )
  }

  if (error === 'expired') {
    return <LinkCheckPage state="expired" footer={sendNewLinkButton} />
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

  if (gate) {
    return (
      <MergeGate
        ownerUsername={gate.owner_username ?? ''}
        guestUsername={gate.guest_username ?? null}
        matchesCount={gate.guest_matches_count}
        busy={consume.isPending}
        onBringThemOver={() => runConsume(false)}
        onNotNow={() => runConsume(true)}
      />
    )
  }

  return <LinkCheckPage state="checking" />
}

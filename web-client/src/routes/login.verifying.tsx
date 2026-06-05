import { useEffect, useRef, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'

import { ApiError } from '@/api/client'
import { useConsumeLoginToken, useMergePreview } from '@/api/session'
import {
  ScreenError,
  ScreenVerify,
  ScreenVerifyNetError,
} from '@/components/login/login-screens'
import { MergeGate } from '@/components/login/merge-gate'
import { pageTitle } from '@/lib/page-title'

type VerifyError = 'expired' | 'net'
type Phase = 'idle' | 'previewing' | 'gate' | 'consuming'

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
  const [phase, setPhase] = useState<Phase>('idle')
  const fired = useRef(false)

  const runConsume = (skipMerge: boolean) => {
    setPhase('consuming')
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
    setPhase('previewing')
    preview.mutate(token, {
      onSuccess: (p) => {
        if (p.is_merge && p.guest_matches_count > 0) {
          setPhase('gate')
        } else {
          runConsume(false)
        }
      },
      onError: () => runConsume(false),
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, error])

  if (!token && !error) {
    return (
      <ScreenError
        detail="This link is missing its token."
        onRequestNew={() =>
          navigate({ to: '/login', search: { error: undefined, email: undefined } })
        }
      />
    )
  }

  if (error === 'expired') {
    return (
      <ScreenError
        onRequestNew={() =>
          navigate({ to: '/login', search: { error: undefined, email: undefined } })
        }
      />
    )
  }

  if (error === 'net') {
    return (
      <ScreenVerifyNetError
        retrying={consume.isPending}
        onRetry={() => {
          fired.current = false
          setPhase('idle')
          navigate({ to: '/login/verifying', search: { token, error: undefined } })
        }}
        onSendNewLink={() =>
          navigate({ to: '/login', search: { error: undefined, email: undefined } })
        }
      />
    )
  }

  if (phase === 'gate' && preview.data) {
    const p = preview.data
    return (
      <MergeGate
        ownerUsername={p.owner_username ?? ''}
        guestUsername={p.guest_username ?? null}
        matchesCount={p.guest_matches_count}
        busy={consume.isPending}
        onBringThemOver={() => runConsume(false)}
        onNotNow={() => runConsume(true)}
      />
    )
  }

  return <ScreenVerify />
}

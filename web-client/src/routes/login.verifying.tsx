import { useEffect, useRef, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

import { api, ApiError, unwrap } from '@/api/client'
import { SESSION_QUERY_KEY, type Session } from '@/api/session'
import {
  ScreenError,
  ScreenVerify,
  ScreenVerifyNetError,
} from '@/components/login/login-screens'
import { pageTitle } from '@/lib/page-title'

type VerifyError = 'expired' | 'net'
type ConsumeState =
  | { status: 'idle' }
  | { status: 'pending' }
  | { status: 'success' }
  | { status: 'error'; error: unknown }

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
  const qc = useQueryClient()
  const [state, setState] = useState<ConsumeState>({ status: 'idle' })
  const fired = useRef(false)

  // Fire the consume exactly once across mounts and pick up the result on
  // whichever render observes it. We intentionally don't cancel from the
  // effect cleanup: StrictMode's simulated unmount fires the cleanup before
  // the response arrives, and a second mount whose effect early-returns
  // would then never learn the outcome.
  useEffect(() => {
    if (fired.current || !token || error) return
    fired.current = true
    setState({ status: 'pending' })
    ;(async () => {
      try {
        const result = await api.POST('/v1/login/consume', { body: { token } })
        const session = unwrap('sign in', result) as Session
        qc.setQueryData(SESSION_QUERY_KEY, session)
        const movedMatches = session.merged?.matches_moved ?? 0
        if (movedMatches > 0) {
          toast.success(
            movedMatches === 1
              ? 'We brought your 1 match with you.'
              : `We brought your ${movedMatches} matches with you.`,
          )
        }
        setState({ status: 'success' })
      } catch (err) {
        setState({ status: 'error', error: err })
      }
    })()
  }, [token, error, qc])

  useEffect(() => {
    if (state.status === 'success') {
      navigate({ to: '/login/welcome' })
    } else if (state.status === 'error') {
      const err = state.error
      if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
        navigate({
          to: '/login/verifying',
          search: { token: '', error: 'expired' },
        })
      } else {
        navigate({
          to: '/login/verifying',
          search: { token, error: 'net' },
        })
      }
    }
  }, [state, navigate, token])

  if (!token && !error) {
    return (
      <ScreenError
        detail="This link is missing its token."
        onRequestNew={() =>
          navigate({
            to: '/login',
            search: { error: undefined, email: undefined },
          })
        }
      />
    )
  }

  if (error === 'expired') {
    return (
      <ScreenError
        onRequestNew={() =>
          navigate({
            to: '/login',
            search: { error: undefined, email: undefined },
          })
        }
      />
    )
  }

  if (error === 'net') {
    return (
      <ScreenVerifyNetError
        retrying={state.status === 'pending'}
        onRetry={() => {
          fired.current = false
          setState({ status: 'idle' })
          navigate({
            to: '/login/verifying',
            search: { token, error: undefined },
          })
        }}
        onSendNewLink={() =>
          navigate({
            to: '/login',
            search: { error: undefined, email: undefined },
          })
        }
      />
    )
  }

  return <ScreenVerify />
}

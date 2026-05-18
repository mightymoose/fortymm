import { useEffect } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'

import { useSession } from '@/api/session'
import { ScreenSuccess } from '@/components/login/login-screens'
import { pageTitle } from '@/lib/page-title'

// Long enough for the success card to register, short enough that the user
// doesn't feel stuck. Matches the "2s" copy in the redirect strip.
const REDIRECT_DELAY_MS = 2000

export const Route = createFileRoute('/login/welcome')({
  head: () => ({
    meta: [{ title: pageTitle('Signed in') }],
  }),
  component: LoginWelcomePage,
})

function LoginWelcomePage() {
  const navigate = useNavigate()
  const { data } = useSession()
  const user = data?.data.user

  useEffect(() => {
    const id = setTimeout(() => navigate({ to: '/dashboard' }), REDIRECT_DELAY_MS)
    return () => clearTimeout(id)
  }, [navigate])

  return (
    <ScreenSuccess
      username={user?.username ?? ''}
      email={user?.email ?? null}
    />
  )
}

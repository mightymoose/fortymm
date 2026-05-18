import { createFileRoute, useNavigate } from '@tanstack/react-router'

import { ScreenSent, ScreenSentBounced } from '@/components/login/login-screens'
import { pageTitle } from '@/lib/page-title'

export const Route = createFileRoute('/login/sent')({
  head: () => ({
    meta: [{ title: pageTitle('Check your inbox') }],
  }),
  validateSearch: (search: Record<string, unknown>) => ({
    error: search.error === 'bounce' ? ('bounce' as const) : undefined,
    email: typeof search.email === 'string' ? search.email : '',
  }),
  component: LoginSentPage,
})

function LoginSentPage() {
  const { error, email } = Route.useSearch()
  const navigate = useNavigate()

  // Both "resend" and "start over" route back to /login with the email
  // prefilled. The captcha can't replay across page loads, so we have to
  // get the user through the challenge again to send a new link.
  const back = () => {
    navigate({
      to: '/login',
      search: { email: email || undefined, error: undefined },
    })
  }

  if (error === 'bounce') {
    return <ScreenSentBounced email={email} onChangeEmail={back} onRetry={back} />
  }

  return (
    <ScreenSent
      email={email || 'your inbox'}
      onStartOver={back}
      onResend={back}
    />
  )
}

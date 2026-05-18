import { createFileRoute } from '@tanstack/react-router'

import { ScreenSuccess } from '@/components/login/login-screens'
import { pageTitle } from '@/lib/page-title'

export const Route = createFileRoute('/login/welcome')({
  head: () => ({
    meta: [{ title: pageTitle('Signed in') }],
  }),
  component: ScreenSuccess,
})

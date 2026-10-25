import { createFileRoute } from '@tanstack/react-router'
import { Home } from '../../pages/Home'

export const Route = createFileRoute('/_authenticated/')({
  // The API's callback adds `signed_in=1` after a sign-in. The router parses
  // the 1 as a number.
  validateSearch: (search: Record<string, unknown>): { signed_in?: 1 } =>
    search.signed_in === 1 || search.signed_in === '1' ? { signed_in: 1 } : {},
  component: Home,
})

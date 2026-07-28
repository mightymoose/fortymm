import { createFileRoute } from '@tanstack/react-router'

import { ClaudeAccessPage } from '@/components/settings/claude-access-page'
import { pageTitle } from '@/lib/page-title'

/**
 * `/settings/claude`.
 *
 * The trailing underscore on `settings_` opts this route OUT of nesting under
 * the existing `/settings` route: it shares the URL prefix but not the layout,
 * so the 1,200-line settings page needs no refactor into an `<Outlet>` host.
 * (Same device as `players/$userId_.matches`.)
 */
export const Route = createFileRoute('/_app/settings_/claude')({
  head: () => ({
    meta: [{ title: pageTitle('Claude access') }],
  }),
  component: ClaudeAccessPage,
})

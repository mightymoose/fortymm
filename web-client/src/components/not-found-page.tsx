import { Link, useRouterState } from '@tanstack/react-router'
import { AppShell } from '@/components/app-shell'
import { NotFoundContent } from '@/components/not-found-content'

/**
 * Router-level catch-all for unknown URLs (`defaultNotFoundComponent`). Owns
 * the app shell and the *generic* copy; the designed body itself lives in
 * `NotFoundContent`, which routes already under the `_app` layout render on
 * their own — wrapping it in a second `AppShell` there would render two
 * `<main>` landmarks.
 */
export function NotFoundPage() {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  return (
    <AppShell>
      <NotFoundContent
        headline={
          <>
            Page not
            <br />
            found.
          </>
        }
        body={
          <>
            That URL doesn&rsquo;t lead anywhere we know about. The page may
            have moved, or the link might be off.
          </>
        }
        meta={{ label: 'Requested path', value: pathname }}
        action={<Link to="/dashboard">Back to dashboard</Link>}
      />
    </AppShell>
  )
}

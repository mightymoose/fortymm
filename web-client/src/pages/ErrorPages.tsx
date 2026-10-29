import { Link, type ErrorComponentProps } from '@tanstack/react-router'
import { classifyFailure } from '../api/errors'
import { Button } from '../components/Button'
import { ErrorScreen } from '../components/ErrorScreen'
import { Icon } from '../components/Icon'

function TryAgain() {
  return (
    <Button variant="primary" onClick={() => window.location.reload()}>
      Try again
    </Button>
  )
}

function GoHome({ primary = false }: { primary?: boolean }) {
  return (
    <Link to="/" className={primary ? 'fm-btn fm-btn--primary' : 'fm-btn fm-btn--ghost'}>
      Go to Home
    </Link>
  )
}

// The root route's error component: the page shown in place of the app when
// a route fails to load or render.
export function ErrorPage({ error }: ErrorComponentProps) {
  const failure = classifyFailure(error)
  switch (failure.kind) {
    case 'unreachable':
      return (
        <ErrorScreen
          title="Can’t reach FortyMM"
          note={
            <p className="fm-notice">
              <Icon name="info" />
              <span>The server can take a few seconds to start.</span>
            </p>
          }
          actions={<TryAgain />}
        >
          Our server isn’t answering. It may be starting up, or your
          connection may be down. Check your connection, then try again.
        </ErrorScreen>
      )
    case 'rate-limited':
      return (
        <ErrorScreen
          title="Wait a minute, then try again"
          note={
            failure.retryAt && (
              <span className="fm-rest">
                <Icon name="clock" />
                <span>
                  Try again at{' '}
                  <span className="num">
                    {failure.retryAt.toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </span>
              </span>
            )
          }
          actions={<TryAgain />}
        >
          Your network sent a lot of requests in a short time, so we paused it
          for a minute.
        </ErrorScreen>
      )
    case 'broken':
      return (
        <ErrorScreen
          title="Something went wrong"
          actions={
            <>
              <TryAgain />
              <GoHome />
            </>
          }
        >
          FortyMM hit an error loading this page. Try again. If it keeps
          happening, tell us what you were doing.
        </ErrorScreen>
      )
  }
}

// The root route's not-found component: the page for a path that matches no
// route.
export function NotFoundPage() {
  return (
    <ErrorScreen
      title="We can’t find that page"
      actions={
        <>
          <GoHome primary />
          <Button variant="ghost" onClick={() => window.history.back()}>
            Go back
          </Button>
        </>
      }
    >
      The link may be old, or the address may have a typo. Check the address,
      or go back to Home.
    </ErrorScreen>
  )
}

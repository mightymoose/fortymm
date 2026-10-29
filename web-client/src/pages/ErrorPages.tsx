import { Link, type ErrorComponentProps } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { classifyFailure, failureMessages, type Failure } from '../api/errors'
import { Button } from '../components/Button'
import { ErrorScreen } from '../components/ErrorScreen'
import { Icon } from '../components/Icon'
import { RetryTime } from '../components/RetryTime'

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
  const { title, sentence } = failureMessages[failure.kind]
  return (
    <ErrorScreen
      title={title}
      note={note(failure)}
      actions={
        failure.kind === 'broken' ? (
          <>
            <TryAgain />
            <GoHome />
          </>
        ) : (
          <TryAgain />
        )
      }
    >
      {sentence}
    </ErrorScreen>
  )
}

function note(failure: Failure): ReactNode {
  switch (failure.kind) {
    case 'unreachable':
      return (
        <p className="fm-notice">
          <Icon name="info" />
          <span>The server can take a few seconds to start.</span>
        </p>
      )
    case 'rate-limited':
      return failure.retryAt && <RetryTime at={failure.retryAt} />
    case 'broken':
      return null
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

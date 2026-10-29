import { QueryErrorResetBoundary } from '@tanstack/react-query'
import { Suspense, useId, type ReactNode } from 'react'
import { ErrorBoundary } from 'react-error-boundary'
import { classifyFailure, type Failure } from '../api/errors'
import { Button } from './Button'
import { Icon } from './Icon'

const messages: Record<Failure['kind'], { title: string; body: string }> = {
  unreachable: {
    title: 'Can’t reach FortyMM',
    body: 'Our server isn’t answering. Check your connection, then try again.',
  },
  'rate-limited': {
    title: 'Wait a minute, then try again',
    body: 'Your network sent a lot of requests in a short time.',
  },
  broken: {
    title: 'Something went wrong',
    body: 'This part of the page didn’t load. Try again.',
  },
}

// The loading and error states of one component that reads its data with
// `useSuspenseQuery`. While the data loads, `skeleton` shows in its place.
// If the request fails, an inline alert does, and its Try again resets the
// failed queries so they fetch again. `actions` go after Try again.
export function QueryBoundary({
  skeleton,
  actions,
  children,
}: {
  skeleton: ReactNode
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <QueryErrorResetBoundary>
      {({ reset }) => (
        <ErrorBoundary
          onReset={reset}
          fallbackRender={({ error, resetErrorBoundary }) => (
            <QueryError error={error} onRetry={resetErrorBoundary} actions={actions} />
          )}
        >
          <Suspense fallback={skeleton}>{children}</Suspense>
        </ErrorBoundary>
      )}
    </QueryErrorResetBoundary>
  )
}

function QueryError({
  error,
  onRetry,
  actions,
}: {
  error: unknown
  onRetry: () => void
  actions?: ReactNode
}) {
  const titleId = useId()
  const { title, body } = messages[classifyFailure(error).kind]
  return (
    <div className="fm-alert fm-alert--error" role="alert" aria-labelledby={titleId}>
      <Icon name="error" />
      <p className="fm-alert__title" id={titleId}>
        {title}
      </p>
      <p className="fm-alert__body">{body}</p>
      <div className="fm-alert__actions">
        <Button variant="primary" size="sm" onClick={onRetry}>
          Try again
        </Button>
        {actions}
      </div>
    </div>
  )
}

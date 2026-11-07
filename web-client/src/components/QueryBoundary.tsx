import { QueryErrorResetBoundary } from '@tanstack/react-query'
import { Suspense, useId, type ReactNode } from 'react'
import { ErrorBoundary } from 'react-error-boundary'
import { classifyFailure, failureMessages } from '../api/errors'
import { Button } from './Button'
import { Icon } from './Icon'
import { RetryTime } from './RetryTime'

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

export function QueryError({
  error,
  onRetry,
  actions,
}: {
  error: unknown
  onRetry: () => void
  actions?: ReactNode
}) {
  const titleId = useId()
  const failure = classifyFailure(error)
  const { title, sentence } = failureMessages[failure.kind]
  return (
    <div className="fm-alert fm-alert--error" role="alert" aria-labelledby={titleId}>
      <Icon name="error" />
      <p className="fm-alert__title" id={titleId}>
        {title}
      </p>
      <p className="fm-alert__body">
        {sentence}
        {failure.kind === 'rate-limited' && failure.retryAt && (
          <>
            {' '}
            <RetryTime at={failure.retryAt} />
          </>
        )}
      </p>
      <div className="fm-alert__actions">
        <Button variant="primary" size="sm" onClick={onRetry}>
          Try again
        </Button>
        {actions}
      </div>
    </div>
  )
}

import type { ReactNode } from 'react'
import { AlertTriangle, RotateCw } from 'lucide-react'
import { ErrorBoundary, type FallbackProps } from 'react-error-boundary'
import { QueryErrorResetBoundary } from '@tanstack/react-query'

/**
 * Fallback for a failed opponent-picker load (recent opponents or a typeahead
 * search). Stays inside the match card and offers an explicit retry rather
 * than dead-ending the whole page.
 */
function OpponentPickerError({ resetErrorBoundary }: FallbackProps) {
  return (
    <div className="nm-picker-error" role="alert">
      <AlertTriangle size={20} strokeWidth={1.75} className="icon" />
      <div className="body">
        <div className="t">Couldn’t load players</div>
        <div className="d">
          Something went wrong reaching the server. You can still start the
          match without picking an opponent.
        </div>
      </div>
      <button
        type="button"
        className="nm-picker-retry"
        onClick={resetErrorBoundary}
      >
        <RotateCw size={14} strokeWidth={2} />
        Try again
      </button>
    </div>
  )
}

/**
 * Wraps the opponent picker so a failed players request renders an inline
 * error with a retry button instead of crashing the New Match page. The
 * `QueryErrorResetBoundary` lets "Try again" clear React Query's cached error
 * so the picker's queries refetch on reset.
 *
 * The picker's `query` / `showSearch` state lives *above* this boundary (in
 * `OpponentPicker`), so a reset remounts the children without dropping the
 * typed search (#96).
 *
 * `resetKeys` is how the caller says "this is a different view now": the picker
 * passes its `showSearch`, so switching between the recent grid and search
 * clears a failed view's error instead of pinning the fallback over the view
 * the user just moved to (#895). "Try again" stays the in-place recovery.
 */
export function OpponentPickerBoundary({
  children,
  resetKeys,
}: {
  children: ReactNode
  resetKeys?: unknown[]
}) {
  return (
    <QueryErrorResetBoundary>
      {({ reset }) => (
        <ErrorBoundary
          FallbackComponent={OpponentPickerError}
          onReset={reset}
          resetKeys={resetKeys}
        >
          {children}
        </ErrorBoundary>
      )}
    </QueryErrorResetBoundary>
  )
}

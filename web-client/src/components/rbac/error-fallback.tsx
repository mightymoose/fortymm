import type { ReactNode } from 'react'
import { AlertTriangle, Lock } from 'lucide-react'
import {
  ErrorBoundary,
  type FallbackProps,
} from 'react-error-boundary'
import { QueryErrorResetBoundary } from '@tanstack/react-query'
import { ApiError } from '@/api/client'
import { Button } from '@/components/ui/button'

const containerStyle = {
  padding: '48px 24px',
  margin: '32px auto',
  maxWidth: 560,
  textAlign: 'center' as const,
  border: '1px solid rgba(255,77,109,0.4)',
  background: 'rgba(255,77,109,0.05)',
  borderRadius: 'var(--r-md, 10px)',
}
const iconWrap = {
  display: 'inline-flex',
  padding: 14,
  borderRadius: 999,
  marginBottom: 14,
}
const titleStyle = { fontSize: 16, fontWeight: 600, color: 'var(--fg-1)', marginBottom: 6 }
const detailStyle = {
  fontSize: 13,
  color: 'var(--fg-3)',
  maxWidth: 420,
  margin: '0 auto 18px',
}

/** The "you don't have access" panel. Rendered both reactively (a child
 * endpoint 403s and trips the boundary) and proactively (a page checks the
 * session's permissions before rendering the tool, so unauthorized
 * direct-navigation never sees it). Copy is permission-agnostic because this
 * boundary wraps several admin pages, each gated on a different permission. */
export function AccessDenied() {
  return (
    <div role="alert" style={containerStyle}>
      <div style={{ ...iconWrap, background: 'rgba(110, 130, 255, 0.12)' }}>
        <Lock size={22} color="var(--info, #6e82ff)" strokeWidth={1.75} />
      </div>
      <div style={titleStyle}>You don't have access to this page</div>
      <div style={detailStyle}>
        Ask an administrator to grant you access to this page.
      </div>
    </div>
  )
}

function RbacErrorFallback({ error, resetErrorBoundary }: FallbackProps) {
  // 403s come from a server-side permission gate — show a clearer message than
  // "something went wrong" so unauthorized direct-navigation reads as
  // intentional rather than broken.
  if (error instanceof ApiError && error.status === 403) {
    return <AccessDenied />
  }
  return (
    <div role="alert" style={containerStyle}>
      <div style={{ ...iconWrap, background: 'rgba(255,77,109,0.12)' }}>
        <AlertTriangle size={22} color="var(--loss)" strokeWidth={1.75} />
      </div>
      <div style={titleStyle}>Something went wrong loading this page</div>
      <div style={{ ...detailStyle, fontFamily: 'var(--font-mono)', wordBreak: 'break-word' }}>
        {error instanceof Error ? error.message : String(error)}
      </div>
      <Button onClick={resetErrorBoundary}>Try again</Button>
    </div>
  )
}

export function RbacBoundary({ children }: { children: ReactNode }) {
  return (
    <QueryErrorResetBoundary>
      {({ reset }) => (
        <ErrorBoundary FallbackComponent={RbacErrorFallback} onReset={reset}>
          {children}
        </ErrorBoundary>
      )}
    </QueryErrorResetBoundary>
  )
}

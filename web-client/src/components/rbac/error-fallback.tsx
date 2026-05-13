import type { ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'
import {
  ErrorBoundary,
  type FallbackProps,
} from 'react-error-boundary'
import { QueryErrorResetBoundary } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'

function RbacErrorFallback({ error, resetErrorBoundary }: FallbackProps) {
  return (
    <div
      role="alert"
      style={{
        padding: '48px 24px',
        margin: '32px auto',
        maxWidth: 560,
        textAlign: 'center',
        border: '1px solid rgba(255,77,109,0.4)',
        background: 'rgba(255,77,109,0.05)',
        borderRadius: 'var(--r-md, 10px)',
      }}
    >
      <div
        style={{
          display: 'inline-flex',
          padding: 14,
          background: 'rgba(255,77,109,0.12)',
          borderRadius: 999,
          marginBottom: 14,
        }}
      >
        <AlertTriangle size={22} color="var(--loss)" strokeWidth={1.75} />
      </div>
      <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--fg-1)', marginBottom: 6 }}>
        Something went wrong loading this page
      </div>
      <div
        style={{
          fontSize: 13,
          color: 'var(--fg-3)',
          maxWidth: 420,
          margin: '0 auto 18px',
          fontFamily: 'var(--font-mono)',
          wordBreak: 'break-word',
        }}
      >
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

import { Link, useRouterState } from '@tanstack/react-router'
import { AppShell } from '@/components/app-shell'
import { Button } from '@/components/ui/button'

/**
 * Router-level catch-all for unknown URLs. Renders inside the app shell with
 * the typographic treatment from the "Error and Empty States" design handoff:
 * a mono eyebrow, a big Bebas headline, and a single recovery action.
 */
export function NotFoundPage() {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  return (
    <AppShell>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
          justifyContent: 'center',
          minHeight: '100%',
          padding: '40px clamp(24px, 8vw, 80px)',
          maxWidth: 920,
        }}
      >
        <div
          style={{
            font: '600 11px var(--font-mono)',
            letterSpacing: '0.2em',
            color: 'var(--ball-500)',
            textTransform: 'uppercase',
            marginBottom: 20,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: 'currentColor',
            }}
          />
          404
        </div>
        <h1
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 'clamp(80px, 11vw, 144px)',
            lineHeight: 0.88,
            letterSpacing: '0.01em',
            color: 'var(--fg-1)',
            margin: '0 0 24px',
            textTransform: 'uppercase',
            textWrap: 'balance',
          }}
        >
          Page not
          <br />
          found.
        </h1>
        <p
          style={{
            font: '400 19px var(--font-ui)',
            lineHeight: 1.45,
            color: 'var(--fg-2)',
            margin: '0 0 32px',
            maxWidth: 560,
          }}
        >
          That URL doesn&rsquo;t lead anywhere we know about. The page may have
          moved, or the link might be off.
        </p>
        <div
          aria-label="Requested path"
          style={{
            font: '500 12px var(--font-mono)',
            color: 'var(--fg-3)',
            letterSpacing: '0.08em',
            marginBottom: 28,
            wordBreak: 'break-all',
          }}
        >
          {pathname}
        </div>
        <Button asChild>
          <Link to="/dashboard">Back to dashboard</Link>
        </Button>
      </div>
    </AppShell>
  )
}

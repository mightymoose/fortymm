import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'

/** The mono meta line beneath the body copy — a label/value pair or nothing. */
export interface NotFoundMeta {
  /** Accessible label for the line (e.g. "Requested path"). */
  label: string
  /** The value shown — the root 404 echoes the requested pathname here. */
  value: ReactNode
}

export interface NotFoundContentProps {
  /**
   * The big display headline. A `ReactNode` rather than a string so a caller
   * can force a line break (the root 404 breaks "Page not" / "found.").
   */
  headline: ReactNode
  /** The explanatory sentence beneath the headline. */
  body: ReactNode
  /** Optional mono meta line. Omitted entirely when absent. */
  meta?: NotFoundMeta
  /**
   * The single recovery action. The caller supplies the element — usually a
   * typed TanStack `<Link>` — and this wraps it in a `<Button asChild>`, so
   * link targets stay type-checked at the call site.
   */
  action: ReactNode
}

/**
 * The body of a not-found page, **without** an app shell around it.
 *
 * Uses the typographic treatment from the "Error and Empty States" design
 * handoff: a mono eyebrow, a big Bebas headline, one sentence, an optional mono
 * meta line, and a single recovery action.
 *
 * Shell-less on purpose. `NotFoundPage` wraps it in `<AppShell>` for the
 * router's `defaultNotFoundComponent`; a route that already sits under the
 * `_app` layout (which *is* an `<AppShell>`) renders this directly, because
 * nesting a second `AppShell` would put two `<main>` landmarks on the page.
 */
export function NotFoundContent({
  headline,
  body,
  meta,
  action,
}: NotFoundContentProps) {
  return (
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
        {headline}
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
        {body}
      </p>
      {meta ? (
        <div
          aria-label={meta.label}
          style={{
            font: '500 12px var(--font-mono)',
            color: 'var(--fg-3)',
            letterSpacing: '0.08em',
            marginBottom: 28,
            wordBreak: 'break-all',
          }}
        >
          {meta.value}
        </div>
      ) : null}
      <Button asChild>{action}</Button>
    </div>
  )
}

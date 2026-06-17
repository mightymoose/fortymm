import type { ReactNode } from 'react'

import { Wordmark } from '@/components/wordmark'
import { Eyebrow } from '../atoms'
import { fineprint, linkInline } from '../styles'

export type LinkCheckState = 'checking' | 'success' | 'expired' | 'missing'

const ACCENT: Record<LinkCheckState, string> = {
  checking: 'var(--ball-500)',
  success: 'var(--serve-500)',
  expired: 'var(--loss)',
  missing: 'var(--loss)',
}

const HALO: Record<LinkCheckState, string> = {
  checking: 'rgba(255,122,26,0.20)',
  success: 'rgba(0,226,154,0.16)',
  expired: 'rgba(255,77,109,0.14)',
  missing: 'rgba(255,77,109,0.14)',
}

// The short code shown in the header pill. Distinct per failure so a missing
// link doesn't read identically to an expired one.
const PILL_CODE: Record<LinkCheckState, string> = {
  checking: '03',
  success: '03',
  expired: '!!',
  missing: '??',
}

const DEFAULT_COPY: Record<
  LinkCheckState,
  { eyebrow: string; title: string; subtitle: string }
> = {
  checking: {
    eyebrow: '● Verifying your link',
    title: 'Checking your link',
    subtitle:
      'Hang tight — confirming your sign-in token. This only takes a second.',
  },
  success: {
    eyebrow: '● Verified',
    title: 'You’re in.',
    subtitle:
      'Token confirmed and your email is verified. Taking you to the courts.',
  },
  expired: {
    eyebrow: '● Link expired',
    // Covers both a genuinely expired link and one that was never valid (#522).
    title: "This link can't be used",
    subtitle:
      'Sign-in links last 15 minutes and work once. Send a fresh one and you’ll be straight in.',
  },
  missing: {
    eyebrow: '● Link incomplete',
    // Distinct from `expired`: the link arrived without its token at all
    // (often truncated when copied), so "expired or already used" is wrong.
    title: 'This link is incomplete',
    subtitle:
      'This sign-in link is missing its token — it may have been cut off when it was copied. Open the most recent link in full, or send yourself a fresh one.',
  },
}

export interface LinkCheckPageProps {
  state: LinkCheckState
  eyebrow?: ReactNode
  title?: ReactNode
  subtitle?: ReactNode
  /** Extra detail rendered under the subtitle — e.g. the API error message. */
  detail?: string
  /** Footer action(s). Routes inject router-aware links/buttons here; when
   *  omitted, the `checking` state shows a "keep this tab open" hint. */
  footer?: ReactNode
}

/**
 * The focused, single-column page a sign-in / email-confirmation link opens to.
 * It checks the token and resolves to one of three states — `checking`,
 * `success`, `expired` — reusing the FortyMM login vocabulary (ball logo, brand
 * dot-grid texture, status disc, Bebas headline). Purely presentational: the
 * owning route drives `state` from its query and supplies the `footer` action.
 */
export function LinkCheckPage({
  state,
  eyebrow,
  title,
  subtitle,
  detail,
  footer,
}: LinkCheckPageProps) {
  const accent = ACCENT[state]
  const copy = DEFAULT_COPY[state]

  return (
    <div
      className="fortymm-theme fmm-login fmm-linkcheck"
      data-testid="link-check-page"
      data-state={state}
    >
      <div className="fortymm-grid-bg fmm-linkcheck__grid" aria-hidden="true" />
      <div
        className="fmm-linkcheck__halo"
        aria-hidden="true"
        style={{
          background: `radial-gradient(circle, ${HALO[state]}, transparent 65%)`,
        }}
      />

      <header className="fmm-linkcheck__header">
        <Wordmark size={22} />
        <span className="fmm-linkcheck__pill" style={{ color: accent }}>
          {PILL_CODE[state]} · LINK
        </span>
      </header>

      <main className="fmm-linkcheck__main">
        <StatusDisc state={state} />
        <div role="status" aria-live="polite">
          <Eyebrow color={accent}>{eyebrow ?? copy.eyebrow}</Eyebrow>
          <h1 className="fmm-linkcheck__title">{title ?? copy.title}</h1>
          <p className="fmm-linkcheck__sub">{subtitle ?? copy.subtitle}</p>
          {detail && (
            <p
              className="fmm-linkcheck__detail"
              style={{ color: accent }}
            >
              {detail}
            </p>
          )}
        </div>
      </main>

      <footer className="fmm-linkcheck__footer">
        {footer}
        {!footer && state === 'checking' && (
          <p style={{ ...fineprint, textAlign: 'center', marginTop: 0 }}>
            Keep this tab open while we verify.
          </p>
        )}
        {(state === 'expired' || state === 'missing') && (
          <p style={{ ...fineprint, textAlign: 'center', marginTop: 0 }}>
            Still stuck?{' '}
            <a href="mailto:support@fortymm.com" style={linkInline}>
              Email support
            </a>
            .
          </p>
        )}
      </footer>
    </div>
  )
}

function StatusDisc({ state }: { state: LinkCheckState }) {
  if (state === 'checking') {
    return (
      <div
        className="fmm-linkcheck__disc fmm-linkcheck__disc--spin"
        data-testid="link-check-disc"
        data-kind="spin"
        aria-hidden="true"
      />
    )
  }
  const ok = state === 'success'
  return (
    <div
      className={`fmm-linkcheck__disc ${
        ok ? 'fmm-linkcheck__disc--ok' : 'fmm-linkcheck__disc--err'
      }`}
      data-testid="link-check-disc"
      data-kind={ok ? 'check' : 'x'}
      aria-hidden="true"
    >
      <svg width="36" height="36" viewBox="0 0 24 24" fill="none">
        {ok ? (
          <path
            d="M5 12.5l4 4 10-10"
            stroke="#00E29A"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : (
          <path
            d="M6 6l12 12M18 6L6 18"
            stroke="#FF4D6D"
            strokeWidth="2.4"
            strokeLinecap="round"
          />
        )}
      </svg>
    </div>
  )
}

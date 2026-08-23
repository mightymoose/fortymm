import { btnGhost, btnPrimary } from '@/components/login/styles'

interface MergeGateProps {
  ownerUsername: string
  guestUsername: string | null
  matchesCount: number
  /**
   * True only on a *first* sign-in, where the account being signed into was
   * minted moments ago and `ownerUsername` is a throwaway generated slug. The
   * gate then also says what each choice does to the person's name, because
   * that is the moment the choice is made: accepting keeps the guest name,
   * declining loses it. On every other merge the username does not move, so
   * the gate must not promise it will.
   */
  adoptsGuestUsername?: boolean
  busy: boolean
  onBringThemOver: () => void
  onNotNow: () => void
}

/**
 * Cross-device confirm gate: shown before folding a guest's matches into the
 * account being signed into, so foreign matches are never imported without the
 * owner's say-so. Only rendered when there are matches to carry
 * (`matchesCount > 0`); empty guests finalize silently.
 */
export function MergeGate({
  ownerUsername,
  guestUsername,
  matchesCount,
  adoptsGuestUsername = false,
  busy,
  onBringThemOver,
  onNotNow,
}: MergeGateProps) {
  const matchLabel = matchesCount === 1 ? '1 match' : `${matchesCount} matches`
  const from = guestUsername || 'your guest session'
  const namesTheGuest = adoptsGuestUsername && Boolean(guestUsername)
  return (
    <div
      style={{
        maxWidth: 520,
        margin: '64px auto',
        padding: 24,
        textAlign: 'center',
      }}
    >
      <h1
        style={{
          fontFamily: 'var(--font-display)',
          fontSize: 40,
          margin: '0 0 12px',
        }}
      >
        Bring your matches over?
      </h1>
      <p style={{ color: 'var(--fg-2)' }}>
        You're signing in as <strong>{ownerUsername}</strong>. We can bring the{' '}
        <strong>{matchLabel}</strong> you played in {from} into this account.
      </p>
      {namesTheGuest && (
        <p style={{ color: 'var(--fg-2)' }}>
          This also keeps your name. Bring them over and you stay{' '}
          <strong>{guestUsername}</strong>. Choose not now and you'll be{' '}
          <strong>{ownerUsername}</strong> instead.
        </p>
      )}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          marginTop: 24,
        }}
      >
        {/*
          The login flow styles its buttons with the inline objects in
          `./styles`, not with a CSS class: `.fmm-btn` lives only under
          `.fmm-settings`, and that stylesheet never loads on these routes.
          Neither object carries a disabled look, so — following
          `login-screens.tsx`'s Resend button — each call site applies its own
          while `busy`. The primary also drops its glow, which on its own would
          keep reading as available.
        */}
        <button
          type="button"
          style={{
            ...btnPrimary,
            opacity: busy ? 0.7 : 1,
            boxShadow: busy ? 'none' : btnPrimary.boxShadow,
            cursor: busy ? 'wait' : 'pointer',
          }}
          disabled={busy}
          onClick={onBringThemOver}
        >
          Bring them over
        </button>
        <button
          type="button"
          style={{
            ...btnGhost,
            // The label interpolates a username of up to 40 characters, which
            // can exceed the button's interior at 375px.
            overflowWrap: 'anywhere',
            opacity: busy ? 0.7 : 1,
            cursor: busy ? 'wait' : 'pointer',
          }}
          disabled={busy}
          onClick={onNotNow}
        >
          {namesTheGuest
            ? `Not now — sign me in as ${ownerUsername}`
            : 'Not now — just sign me in'}
        </button>
      </div>
    </div>
  )
}

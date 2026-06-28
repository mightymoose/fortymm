interface MergeGateProps {
  ownerUsername: string
  guestUsername: string | null
  matchesCount: number
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
  busy,
  onBringThemOver,
  onNotNow,
}: MergeGateProps) {
  const matchLabel = matchesCount === 1 ? '1 match' : `${matchesCount} matches`
  const from = guestUsername || 'your guest session'
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
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          marginTop: 24,
        }}
      >
        <button
          type="button"
          className="fmm-btn fmm-btn--primary"
          disabled={busy}
          onClick={onBringThemOver}
        >
          Bring them over
        </button>
        <button
          type="button"
          className="fmm-btn fmm-btn--quiet"
          disabled={busy}
          onClick={onNotNow}
        >
          Not now — just sign me in
        </button>
      </div>
    </div>
  )
}

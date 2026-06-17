/**
 * The FortyMM wordmark — `FORTY` with an accented `MM`, in the display face.
 * The single brand mark used across the app shell, the landing page, and the
 * login/link-check flows so they can't drift apart.
 */
export function Wordmark({
  size = 22,
  className,
}: {
  /** Font size in px. */
  size?: number
  className?: string
}) {
  return (
    <span
      className={className}
      style={{
        fontFamily: 'var(--font-display)',
        fontSize: size,
        letterSpacing: '0.06em',
        color: 'var(--fg-1)',
        lineHeight: 1,
        whiteSpace: 'nowrap',
      }}
    >
      FORTY<span style={{ color: 'var(--ball-500)' }}>MM</span>
    </span>
  )
}

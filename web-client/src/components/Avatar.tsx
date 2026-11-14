import './Avatar.css'

// The design system's avatar (.fm-avatar): a player's initials on a flat
// circle, 36px, or 28px small. Decoration beside the player's name, which
// says who it is, so assistive technology skips it.
export function Avatar({
  initials,
  size = 'md',
}: {
  initials: string
  size?: 'sm' | 'md'
}) {
  return (
    <span
      className={size === 'sm' ? 'avatar avatar--sm' : 'avatar'}
      aria-hidden="true"
    >
      {initials}
    </span>
  )
}

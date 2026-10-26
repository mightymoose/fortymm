// The initials of a name's first two words, e.g. `EE` for
// `excited egret 387`, or `A` for `ann@example.com`.
function initials(name: string): string {
  return name
    .split(' ')
    .slice(0, 2)
    .map((word) => word[0])
    .join('')
    .toUpperCase()
}

// An avatar of `name`'s initials, styled by `.fm-avatar` in styles/kit.css.
// Its accessible name is the full name.
export function PlayerAvatar({ name, className }: { name: string; className?: string }) {
  return (
    <span
      className={className ? `fm-avatar ${className}` : 'fm-avatar'}
      role="img"
      aria-label={name}
    >
      {initials(name)}
    </span>
  )
}

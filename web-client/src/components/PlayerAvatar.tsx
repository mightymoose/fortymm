import { initials } from './initials'

// An avatar of a display name's initials, styled by `.fm-avatar` in
// styles/kit.css. Its accessible name is the full name.
export function PlayerAvatar({ name }: { name: string }) {
  return (
    <span className="fm-avatar" role="img" aria-label={name}>
      {initials(name)}
    </span>
  )
}

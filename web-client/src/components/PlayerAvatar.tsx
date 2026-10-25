import { useQuery } from '@tanstack/react-query'
import { useRouteContext } from '@tanstack/react-router'
import { sessionQuery } from '../api/queries'
import { useTooltip } from './tooltipContext'

// The initials of a display name's first two words, e.g. `EE` for
// `excited egret 387`.
function initials(displayName: string): string {
  return displayName
    .split(' ')
    .slice(0, 2)
    .map((word) => word[0])
    .join('')
    .toUpperCase()
}

// The visitor's player, as an avatar of their display name's initials. It
// shows nothing until the session has started, or for an account with no
// player. It doesn't suspend, so the
// loading screen times only the page.
export function PlayerAvatar() {
  const { api } = useRouteContext({ from: '__root__' })
  const { data: account } = useQuery(sessionQuery(api))
  const displayName = account?.player?.display_name ?? ''
  const tooltip = useTooltip(displayName)

  if (!account?.player) return null
  return (
    <span className="fm-avatar app-avatar" role="img" aria-label={displayName} {...tooltip}>
      {initials(displayName)}
    </span>
  )
}

import { useQuery } from '@tanstack/react-query'
import { useRouteContext } from '@tanstack/react-router'
import { sessionQuery } from '../api/queries'
import { initials } from './initials'
import { useTooltip } from './tooltipContext'

// The visitor's player, as an avatar of their display name's initials. It
// shows nothing until the session has started. It doesn't suspend, so the
// loading screen times only the page.
export function PlayerAvatar() {
  const { api } = useRouteContext({ from: '__root__' })
  const { data: account } = useQuery(sessionQuery(api))
  const displayName = account?.player.display_name ?? ''
  const tooltip = useTooltip(displayName)

  if (!account) return null
  return (
    <span className="fm-avatar app-avatar" role="img" aria-label={displayName} {...tooltip}>
      {initials(displayName)}
    </span>
  )
}

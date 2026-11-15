import { Outlet } from '@tanstack/react-router'

// The layout route of every page under /matches (src/routes/matches.tsx): the
// current page, in the router's <Outlet />, and nothing of its own. It is the
// one place a later change adds what all those pages share: the route's loader
// awaits the match store's load, and this becomes the connected component
// that watches it (web-client/CLAUDE.md).
export function Matches() {
  return <Outlet />
}

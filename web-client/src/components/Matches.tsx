import { Outlet } from '@tanstack/react-router'

// The layout route of every page under /matches (src/routes/matches.tsx): the
// current page, in the router's <Outlet />, and nothing of its own. It is the
// one place a later change adds what all those pages share. One match's
// pages share its own layout, Match.tsx, which watches that match.
export function Matches() {
  return <Outlet />
}

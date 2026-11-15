import { Outlet } from '@tanstack/react-router'
import { useEffect } from 'react'
import { matchStore } from '../stores/match.ts'

// The layout of every page of one match (src/routes/matches/$matchId.tsx):
// the current page, in the router's <Outlet />, with the match store
// watching the match while it is mounted, so a change to the match, made on
// this page or elsewhere, shows on the page.
export function Match({ matchId }: { matchId: string }) {
  useEffect(() => matchStore.getState().watchMatch(matchId), [matchId])
  return <Outlet />
}

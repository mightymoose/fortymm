import { createFileRoute, notFound } from '@tanstack/react-router'

// /matches/$matchId has no page of its own yet (the match's details page
// comes later). Without this route the layout above ($matchId.tsx) would
// match it and show an empty page; this keeps it the not-found page.
export const Route = createFileRoute('/matches/$matchId/')({
  beforeLoad: () => {
    throw notFound()
  },
})

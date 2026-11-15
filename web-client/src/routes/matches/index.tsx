import { createFileRoute, notFound } from '@tanstack/react-router'

// /matches has no page of its own yet. Without this route the layout above
// (matches.tsx) would match it and show an empty page; this keeps it the
// not-found page it was before the layout.
export const Route = createFileRoute('/matches/')({
  beforeLoad: () => {
    throw notFound()
  },
})

import { createFileRoute } from '@tanstack/react-router'
import { Matches } from '../components/Matches.tsx'

// The layout route of every page under /matches (matches/*.tsx). It adds
// nothing yet; what those pages share goes here.
export const Route = createFileRoute('/matches')({
  component: Matches,
})

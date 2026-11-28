import { createFileRoute } from '@tanstack/react-router'
import { AppLayout } from '../components/AppLayout.tsx'

// The app's screens, in the layout they share (AppLayout). A pathless route: it adds nothing to
// their addresses. The design system boards and /health are outside it.
export const Route = createFileRoute('/_app')({
  component: AppLayout,
})

import { createFileRoute } from '@tanstack/react-router'
import { FeedbackTab } from '../../components/FeedbackTab.tsx'

export const Route = createFileRoute('/design-system/feedback')({
  component: FeedbackTab,
})

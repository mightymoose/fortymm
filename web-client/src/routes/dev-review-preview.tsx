import { createFileRoute } from '@tanstack/react-router'
import { PreviewDemo } from '../pages/adoption/PreviewDemo'

export const Route = createFileRoute('/dev-review-preview')({
  component: PreviewDemo,
})

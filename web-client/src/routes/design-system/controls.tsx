import { createFileRoute } from '@tanstack/react-router'
import { ControlsTab } from '../../components/ControlsTab.tsx'

export const Route = createFileRoute('/design-system/controls')({
  component: ControlsTab,
})

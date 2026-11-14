import { createFileRoute } from '@tanstack/react-router'
import { FoundationsTab } from '../../components/FoundationsTab.tsx'

export const Route = createFileRoute('/design-system/foundations')({
  component: FoundationsTab,
})

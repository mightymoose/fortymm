import { createFileRoute } from '@tanstack/react-router'
import { ColourTab } from '../../components/ColourTab.tsx'

export const Route = createFileRoute('/design-system/colour')({
  component: ColourTab,
})

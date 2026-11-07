import { createFileRoute } from '@tanstack/react-router'
import { DesignSystem } from '../pages/DesignSystem'
import { loadTestModeFonts } from '../testMode'

export const Route = createFileRoute('/design-system')({
  loader: loadTestModeFonts,
  component: DesignSystem,
})

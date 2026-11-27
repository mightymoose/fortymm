import { createFileRoute } from '@tanstack/react-router'
import { DesignSystemOverlaysScreen } from '../../components/design-system/DesignSystemOverlaysScreen.tsx'

export const Route = createFileRoute('/design-system/overlays')({
  component: DesignSystemOverlaysScreen,
})

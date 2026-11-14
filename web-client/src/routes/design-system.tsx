import { createFileRoute } from '@tanstack/react-router'
import { DesignSystemScreen } from '../components/DesignSystemScreen.tsx'

export const Route = createFileRoute('/design-system')({
  component: DesignSystemScreen,
})

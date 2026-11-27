import { createFileRoute } from '@tanstack/react-router'
import { DesignSystemMoreScreen } from '../../components/design-system/DesignSystemMoreScreen.tsx'

export const Route = createFileRoute('/design-system/more')({
  component: DesignSystemMoreScreen,
})

import { createFileRoute } from '@tanstack/react-router'
import { DesignSystemMainScreen } from '../../components/design-system/DesignSystemMainScreen.tsx'

export const Route = createFileRoute('/design-system/')({
  component: DesignSystemMainScreen,
})

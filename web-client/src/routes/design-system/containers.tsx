import { createFileRoute } from '@tanstack/react-router'
import { DesignSystemContainersScreen } from '../../components/design-system/DesignSystemContainersScreen.tsx'

export const Route = createFileRoute('/design-system/containers')({
  component: DesignSystemContainersScreen,
})

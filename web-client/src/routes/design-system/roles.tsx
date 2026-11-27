import { createFileRoute } from '@tanstack/react-router'
import { DesignSystemRolesScreen } from '../../components/design-system/DesignSystemRolesScreen.tsx'

export const Route = createFileRoute('/design-system/roles')({
  component: DesignSystemRolesScreen,
})

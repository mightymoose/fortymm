import { createFileRoute } from '@tanstack/react-router'
import { DesignSystemStatesScreen } from '../../components/design-system/DesignSystemStatesScreen.tsx'

export const Route = createFileRoute('/design-system/states')({
  component: DesignSystemStatesScreen,
})

import { createFileRoute } from '@tanstack/react-router'
import { DesignSystemMatchScreen } from '../../components/design-system/DesignSystemMatchScreen.tsx'

export const Route = createFileRoute('/design-system/match')({
  component: DesignSystemMatchScreen,
})

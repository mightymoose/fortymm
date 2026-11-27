import { createFileRoute } from '@tanstack/react-router'
import { HealthScreen } from '../components/HealthScreen.tsx'

export const Route = createFileRoute('/health')({
  component: HealthScreen,
})

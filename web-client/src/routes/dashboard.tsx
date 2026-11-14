import { createFileRoute } from '@tanstack/react-router'
import { DashboardScreen } from '../components/DashboardScreen.tsx'

export const Route = createFileRoute('/dashboard')({
  component: DashboardScreen,
})

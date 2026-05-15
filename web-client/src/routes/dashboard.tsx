import { createFileRoute } from '@tanstack/react-router'
import { AppShell } from '@/components/app-shell'
import { DashboardPage } from '@/components/dashboard/dashboard-page'

export const Route = createFileRoute('/dashboard')({
  component: DashboardRoute,
})

function DashboardRoute() {
  return (
    <AppShell>
      <DashboardPage />
    </AppShell>
  )
}

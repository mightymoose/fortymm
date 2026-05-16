import { createFileRoute } from '@tanstack/react-router'
import { AppShell } from '@/components/app-shell'
import { DashboardPage } from '@/components/dashboard/dashboard-page'
import { pageTitle } from '@/lib/page-title'

export const Route = createFileRoute('/dashboard')({
  head: () => ({
    meta: [{ title: pageTitle('Dashboard') }],
  }),
  component: DashboardRoute,
})

function DashboardRoute() {
  return (
    <AppShell>
      <DashboardPage />
    </AppShell>
  )
}

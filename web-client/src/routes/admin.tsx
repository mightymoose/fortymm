import { createFileRoute } from '@tanstack/react-router'
import { AppShell } from '@/components/app-shell'

export const Route = createFileRoute('/admin')({
  component: AdminPage,
})

function AdminPage() {
  return (
    <AppShell>
      <div className="mx-auto max-w-[1200px] px-12 pt-16 pb-32">
        <h1 className="font-display text-4xl text-foreground">Administration</h1>
      </div>
    </AppShell>
  )
}

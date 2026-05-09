import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/dashboard')({
  component: DashboardPage,
})

function DashboardPage() {
  return (
    <div className="dark fortymm-theme min-h-screen">
      <div className="mx-auto max-w-[1200px] px-12 pt-16 pb-32">
        <h1 className="font-display text-4xl text-foreground">Dashboard</h1>
      </div>
    </div>
  )
}

import { createFileRoute } from '@tanstack/react-router'
import { SystemHealth } from '@/components/system-health'
import { pageTitle } from '@/lib/page-title'

export const Route = createFileRoute('/admin/')({
  head: () => ({
    meta: [{ title: pageTitle('Administration') }],
  }),
  component: AdminOverview,
})

function AdminOverview() {
  return (
    <div className="mx-auto max-w-[1200px] px-12 pt-16 pb-32">
      <header className="mb-10">
        <h1 className="font-display text-4xl text-foreground">Administration</h1>
      </header>
      <section aria-label="Operations" className="mb-12 max-w-[640px]">
        <SystemHealth />
      </section>
    </div>
  )
}

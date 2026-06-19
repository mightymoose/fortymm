import { createFileRoute } from '@tanstack/react-router'
import { AdminOverview } from '@/components/admin-overview'
import { pageTitle } from '@/lib/page-title'

export const Route = createFileRoute('/_app/admin/')({
  head: () => ({
    meta: [{ title: pageTitle('Administration') }],
  }),
  component: AdminOverview,
})

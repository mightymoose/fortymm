import { createFileRoute } from '@tanstack/react-router'
import { BroadcastPage } from '@/components/notifications/broadcast-page'
import { pageTitle } from '@/lib/page-title'

export const Route = createFileRoute('/admin/broadcast')({
  head: () => ({
    meta: [{ title: pageTitle('Broadcast · Admin') }],
  }),
  component: BroadcastPage,
})

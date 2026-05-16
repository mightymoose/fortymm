import { createFileRoute } from '@tanstack/react-router'
import { sessionQueryOptions } from '@/api/session'
import App from '../App'

export const Route = createFileRoute('/')({
  head: () => ({
    meta: [{ title: 'FortyMM — table tennis, properly tracked' }],
  }),
  loader: ({ context: { queryClient } }) => {
    void queryClient.prefetchQuery(sessionQueryOptions())
  },
  component: App,
})

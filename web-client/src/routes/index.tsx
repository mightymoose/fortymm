import { createFileRoute } from '@tanstack/react-router'
import { sessionQueryOptions } from '@/api/session'
import App from '../App'

export const Route = createFileRoute('/')({
  loader: ({ context: { queryClient } }) => {
    void queryClient.prefetchQuery(sessionQueryOptions())
  },
  component: App,
})

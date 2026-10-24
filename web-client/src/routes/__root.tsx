import type { QueryClient } from '@tanstack/react-query'
import { createRootRouteWithContext } from '@tanstack/react-router'
import type { ApiClient } from '../api/client'
import { Root } from '../pages/Root'

type RouterContext = {
  api: ApiClient
  queryClient: QueryClient
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: Root,
})

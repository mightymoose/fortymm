import type { QueryClient } from '@tanstack/react-query'
import { createRootRouteWithContext } from '@tanstack/react-router'
import type { ApiClient } from '../api/client'
import { ErrorPage, NotFoundPage } from '../pages/ErrorPages'
import { Root } from '../pages/Root'

type RouterContext = {
  api: ApiClient
  queryClient: QueryClient
}

// The root route catches every error and unknown path, so the error pages
// replace the whole app, with no AppShell around them.
export const Route = createRootRouteWithContext<RouterContext>()({
  component: Root,
  errorComponent: ErrorPage,
  notFoundComponent: NotFoundPage,
})

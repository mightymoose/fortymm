import { queryOptions } from '@tanstack/react-query'
import { whoami } from './whoami.ts'

// This device's identity, for screens to show (`useQuery(whoamiQuery)`). It changes only when the
// key does, which takes a new page load (site data cleared), so it is never refetched. whoami()
// never throws: a device with no identity is a result, not an error.
export const whoamiQuery = queryOptions({
  queryKey: ['whoami'],
  queryFn: whoami,
  staleTime: Infinity,
})

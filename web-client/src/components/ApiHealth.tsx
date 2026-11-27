import { useQuery } from '@tanstack/react-query'
import { useId } from 'react'
import { healthQuery } from './health-query.ts'

// The api's health: is it answering, and is its core healthy? The core is unknown when the api
// can't be reached.
export function ApiHealth() {
  const headingId = useId()
  const health = useQuery(healthQuery)
  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId}>API</h2>
      <p role="status">
        {health.isPending
          ? 'Server: checking…'
          : health.isSuccess
            ? `Server: ${health.data.data.server}`
            : 'Server: unreachable'}
      </p>
      <p role="status">
        {health.isPending
          ? 'Core: checking…'
          : health.isSuccess
            ? `Core: ${health.data.data.coreHealthy ? 'healthy' : 'unhealthy'}`
            : 'Core: unknown'}
      </p>
    </section>
  )
}

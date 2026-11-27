import { useQuery } from '@tanstack/react-query'
import { useId } from 'react'
import { webCoreHealthQuery } from './web-core-health-query.ts'

// The web client's health: does the core work in this browser?
export function WebClientHealth() {
  const headingId = useId()
  const core = useQuery(webCoreHealthQuery)
  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId}>Web client</h2>
      <p role="status">
        {core.isPending ? 'Core: checking…' : core.data ? 'Core: healthy' : 'Core: unhealthy'}
      </p>
    </section>
  )
}

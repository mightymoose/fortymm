import { useQuery } from '@tanstack/react-query'
import { healthQuery } from './health-query.ts'

export function HealthScreen() {
  const health = useQuery(healthQuery)
  return (
    <main>
      <h1>Health</h1>
      <p role="status">
        {health.isPending
          ? 'Checking…'
          : health.isSuccess
            ? `Server: ${health.data.data.server}`
            : 'Server: unreachable'}
      </p>
    </main>
  )
}

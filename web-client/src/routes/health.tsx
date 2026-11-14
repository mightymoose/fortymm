import { createFileRoute } from '@tanstack/react-router'
import { fetchHealth } from '../api/health.ts'
import { HealthScreen } from '../components/HealthScreen.tsx'
import { checkCore } from '../core/check.ts'

// The loader runs on every visit and starts both checks without waiting for
// either; the screen shows each answer when it arrives.
export const Route = createFileRoute('/health')({
  loader: () => ({ health: fetchHealth(), core: checkCore() }),
  component: HealthRoute,
})

function HealthRoute() {
  const { health, core } = Route.useLoaderData()
  return <HealthScreen health={health} core={core} />
}

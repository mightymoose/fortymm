import { ApiHealth } from './ApiHealth.tsx'
import { WebClientHealth } from './WebClientHealth.tsx'

export function HealthScreen() {
  return (
    <main>
      <h1>Health</h1>
      <ApiHealth />
      <WebClientHealth />
    </main>
  )
}

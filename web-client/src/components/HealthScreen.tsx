import { Await } from '@tanstack/react-router'
import type { Health } from '../api/health.ts'
import type { CoreCheck } from '../core/check.ts'

// The health page, at /health: what the api answered when asked whether it can
// reach its database (fetchHealth, src/api/health.ts), and whether this device
// loaded the shared core (checkCore, src/core/check.ts). It takes both answers
// still on their way: the page shows at once, and each answer replaces its own
// "checking" line when it arrives, so a slow api (one that takes seconds to
// fail) never holds up the core's answer. Neither promise rejects: every
// answer is data, not an error.
export function HealthScreen({
  health,
  core,
}: {
  health: Promise<Health>
  core: Promise<CoreCheck>
}) {
  // Each answer sits in a live region of its own that stays on the page, so a
  // screen reader announces the answer when it replaces "checking".
  return (
    <section id="center">
      <div>
        <h1>API health</h1>
        <div role="status">
          <Await promise={health} fallback={<h2>Checking the API’s health</h2>}>
            {(answer) => <ApiAnswer health={answer} />}
          </Await>
        </div>
        <div role="status" aria-labelledby="core-answer">
          <Await
            promise={core}
            fallback={<h2 id="core-answer">Loading the shared core</h2>}
          >
            {(answer) => <CoreAnswer core={answer} />}
          </Await>
        </div>
      </div>
    </section>
  )
}

const answers: Record<Health['status'], { title: string; detail: string }> = {
  healthy: {
    title: 'The API is healthy',
    detail: 'It answered, and it can reach its database.',
  },
  'database-unavailable': {
    title: 'The API’s database is unavailable',
    detail: 'The API answered, but it cannot reach its database.',
  },
  unknown: {
    title: 'The API’s health is unknown',
    detail:
      'The API could not be reached, or it gave an answer this page does not understand.',
  },
}

function ApiAnswer({ health }: { health: Health }) {
  const { title, detail } = answers[health.status]
  return (
    <>
      <h2>{title}</h2>
      <p>{detail}</p>
    </>
  )
}

function CoreAnswer({ core }: { core: CoreCheck }) {
  return core.loaded ? (
    <>
      <h2 id="core-answer">The shared core loaded</h2>
      <p>
        It names player {core.playerId.slice(0, 8)}…{' '}
        <code>{core.username}</code>.
      </p>
    </>
  ) : (
    <>
      <h2 id="core-answer">The shared core did not load</h2>
      <p>This device could not load it.</p>
    </>
  )
}

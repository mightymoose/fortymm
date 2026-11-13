import { Await, createFileRoute, Link } from '@tanstack/react-router'
import { fetchHealth, type Health } from '../api/health.ts'
import { loadCore } from '../core/load.ts'

// /health: asks the api whether it can reach its database, and says what it
// answered; and says whether this device loaded the shared core, with an
// answer only the core can give. The loader runs on every visit and starts
// both checks without waiting for either: the page shows at once, and each
// answer replaces its own "checking" line when it arrives, so a slow api
// (one that takes seconds to fail) never holds up the core's answer. Neither
// check throws, so every answer is data, not an error.
export const Route = createFileRoute('/health')({
  loader: () => ({ health: fetchHealth(), core: checkCore() }),
  component: HealthPage,
})

// The core's check: the generated username of a fixed player id. The id and
// its username are a golden vector of the core's (core/vectors/vectors.json,
// "usernames"), so a core that loaded and answered gives exactly that name.
const checkedPlayerId =
  'e2286f7cd2dc62c15a00bdb33f6e78167112a99a9f072d066e4e9dd3fc9d1c25'
const checkedSuffixLength = 4

type CoreCheck = { loaded: true; username: string } | { loaded: false }

async function checkCore(): Promise<CoreCheck> {
  try {
    const core = await loadCore()
    return {
      loaded: true,
      username: core.username(bytesOfHex(checkedPlayerId), checkedSuffixLength),
    }
  } catch {
    return { loaded: false }
  }
}

function bytesOfHex(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16))
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

// Each answer sits in a live region of its own that stays on the page, so a
// screen reader announces the answer when it replaces "checking".
function HealthPage() {
  const { health, core } = Route.useLoaderData()
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
      <Link to="/">Go to the start page</Link>
    </section>
  )
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
        It names player {checkedPlayerId.slice(0, 8)}…{' '}
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

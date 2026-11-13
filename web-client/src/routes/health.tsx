import { createFileRoute, Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { fetchHealth, type Health } from '../api/health.ts'
import { loadCore } from '../core/load.ts'

// /health: asks the api whether it can reach its database, and says what it
// answered; and says whether this device loaded the shared core, with an
// answer only the core can give. The loader runs on every visit. Neither
// check throws, so every answer is data, not an error, and one failing never
// hides the other.
export const Route = createFileRoute('/health')({
  loader: async () => {
    const [health, core] = await Promise.all([fetchHealth(), checkCore()])
    return { health, core }
  },
  // Say "checking" as soon as the request is out, not after the router's
  // default second.
  pendingMs: 0,
  pendingComponent: Checking,
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

function HealthPage() {
  const { health, core } = Route.useLoaderData()
  const { title, detail } = answers[health.status]
  return (
    <HealthLayout title={title} core={<CoreAnswer core={core} />}>
      <p>{detail}</p>
    </HealthLayout>
  )
}

function CoreAnswer({ core }: { core: CoreCheck }) {
  return (
    <div role="status" aria-labelledby="core-answer">
      {core.loaded ? (
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
      )}
    </div>
  )
}

function Checking() {
  return <HealthLayout title="Checking the API’s health" />
}

function HealthLayout({
  title,
  children,
  core,
}: {
  title: string
  children?: ReactNode
  core?: ReactNode
}) {
  return (
    <section id="center">
      <div>
        <h1>API health</h1>
        {/* A live region, so a screen reader announces the answer when it
            replaces "checking". */}
        <div role="status">
          <h2>{title}</h2>
          {children}
        </div>
        {core}
      </div>
      <Link to="/">Go to the start page</Link>
    </section>
  )
}

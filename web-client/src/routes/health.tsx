import { createFileRoute, Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { fetchHealth, type Health } from '../api/health.ts'

// /health: asks the api whether it can reach its database, and says what it
// answered. The loader runs on every visit; fetchHealth never throws, so the
// three answers are data, not errors.
export const Route = createFileRoute('/health')({
  loader: () => fetchHealth(),
  // Say "checking" as soon as the request is out, not after the router's
  // default second.
  pendingMs: 0,
  pendingComponent: Checking,
  component: HealthPage,
})

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
  const { title, detail } = answers[Route.useLoaderData().status]
  return (
    <HealthLayout title={title}>
      <p>{detail}</p>
    </HealthLayout>
  )
}

function Checking() {
  return <HealthLayout title="Checking the API’s health" />
}

function HealthLayout({
  title,
  children,
}: {
  title: string
  children?: ReactNode
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
      </div>
      <Link to="/">Go to the start page</Link>
    </section>
  )
}

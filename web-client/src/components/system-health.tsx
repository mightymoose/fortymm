import { useEffect, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  HEALTH_QUERY_KEY,
  useHealth,
  type ComponentHealth,
  type HealthResponse,
} from '@/api/health'

type ServiceKey = 'redis' | 'database' | 'solver'
type ServiceStatus = 'ok' | 'deg' | 'bad' | 'loading'
type OverallState = ServiceStatus

const DEGRADED_LATENCY_MS = 1500

const SERVICES: Array<{ key: ServiceKey; name: string; host: string; icon: ReactNode }> = [
  {
    key: 'redis',
    name: 'Redis',
    host: 'cache.fortymm.internal:6379',
    icon: (
      <svg viewBox="0 0 24 24">
        <ellipse cx="12" cy="5" rx="8" ry="3" />
        <path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
        <path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
      </svg>
    ),
  },
  {
    key: 'database',
    name: 'Database',
    host: 'pg-primary.fortymm.internal:5432',
    icon: (
      <svg viewBox="0 0 24 24">
        <ellipse cx="12" cy="5" rx="9" ry="3" />
        <path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5" />
        <path d="M3 12c0 1.7 4 3 9 3s9-1.3 9-3" />
      </svg>
    ),
  },
  {
    key: 'solver',
    name: 'Solver',
    host: 'smt-solver.fortymm.internal:9100',
    icon: (
      <svg viewBox="0 0 24 24">
        <path d="M4 4h6v6H4z" />
        <path d="M14 4h6v6h-6z" />
        <path d="M4 14h6v6H4z" />
        <circle cx="17" cy="17" r="3" />
      </svg>
    ),
  },
]

const HEADLINES: Record<OverallState, { reg: string; acc: string }> = {
  ok: { reg: 'All systems', acc: 'go' },
  deg: { reg: 'Something is', acc: 'sluggish' },
  bad: { reg: 'Something is', acc: 'down' },
  loading: { reg: 'Pinging the', acc: 'stack' },
}

const LEDES: Record<OverallState, string> = {
  ok: 'Cache, database, and solver are answering on time.',
  deg: 'A dependency is responding slower than expected.',
  bad: "A dependency isn’t answering. Page the on-call.",
  loading: 'Probing redis, database, and solver.',
}

const EYEBROWS: Record<OverallState, string> = {
  ok: 'Operational',
  deg: 'Partial degradation',
  bad: 'Interruption',
  loading: 'Checking',
}

const PILL_LABELS: Record<ServiceStatus, string> = {
  ok: 'healthy',
  deg: 'degraded',
  bad: 'down',
  loading: 'checking…',
}

function classifyComponent(component: ComponentHealth | undefined): ServiceStatus {
  if (!component) return 'loading'
  if (!component.healthy) return 'bad'
  if (component.latency_ms != null && component.latency_ms > DEGRADED_LATENCY_MS) {
    return 'deg'
  }
  return 'ok'
}

function deriveOverall(statuses: ServiceStatus[]): OverallState {
  if (statuses.some((s) => s === 'bad')) return 'bad'
  if (statuses.some((s) => s === 'deg')) return 'deg'
  return 'ok'
}

function formatLatency(ms: number): string {
  if (ms < 1) return ms.toFixed(1)
  if (ms < 100) return ms.toFixed(0)
  return Math.round(ms).toLocaleString()
}

function useTimeAgo(): (date: Date | null) => string {
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => setTick((v) => v + 1), 1000)
    return () => window.clearInterval(id)
  }, [])

  return (date: Date | null) => {
    if (!date) return '—'
    const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000))
    if (seconds < 5) return 'just now'
    if (seconds < 60) return `${seconds}s ago`
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return `${minutes}m ago`
    return `${Math.floor(minutes / 60)}h ago`
  }
}

export function SystemHealth() {
  const queryClient = useQueryClient()
  const query = useHealth()
  const formatTimeAgo = useTimeAgo()

  const running = query.isFetching
  const data: HealthResponse | undefined = query.data
  const errored = !running && query.isError
  const checkedAt =
    !running && query.dataUpdatedAt ? new Date(query.dataUpdatedAt) : null

  const serviceStatuses: Record<ServiceKey, ServiceStatus> = {
    redis: running ? 'loading' : errored ? 'bad' : classifyComponent(data?.redis),
    database: running
      ? 'loading'
      : errored
        ? 'bad'
        : classifyComponent(data?.database),
    solver: running ? 'loading' : errored ? 'bad' : classifyComponent(data?.solver),
  }

  const overall: OverallState = running
    ? 'loading'
    : errored
      ? 'bad'
      : deriveOverall(Object.values(serviceStatuses))

  const headline = HEADLINES[overall]

  function recheck() {
    queryClient.invalidateQueries({ queryKey: HEALTH_QUERY_KEY })
  }

  return (
    <section
      className={`sys-health sys-health--${overall}`}
      data-testid="system-health"
      data-state={overall}
      aria-label="System health"
    >
      <div className="sys-health__head">
        <span className="sys-health__eyebrow">
          <span className="sys-health__pulse" aria-hidden />
          <span data-testid="system-health-eyebrow">{EYEBROWS[overall]}</span>
        </span>
        <span
          className="sys-health__ts"
          data-testid="system-health-checked"
          aria-live="polite"
        >
          checked {formatTimeAgo(checkedAt)}
        </span>
      </div>

      <div className="sys-health__headline">
        <h2>
          {headline.reg}{' '}
          <span className="sys-health__headline-accent">{headline.acc}</span>
          <span className="sys-health__end-dot">.</span>
        </h2>
        <div className="sys-health__ball-art" aria-hidden="true">
          <div className="sys-health__halo" />
          <div className="sys-health__ball" />
        </div>
      </div>

      <p className="sys-health__lede">{LEDES[overall]}</p>

      <div className="sys-health__list">
        {SERVICES.map((service) => {
          const status = serviceStatuses[service.key]
          const component = data?.[service.key]
          const latencyMs = component?.latency_ms ?? null
          const error = component?.error ?? null
          const pillCls =
            status === 'ok'
              ? 'sys-health__pill sys-health__pill--ok'
              : status === 'deg'
                ? 'sys-health__pill sys-health__pill--deg'
                : status === 'bad'
                  ? 'sys-health__pill sys-health__pill--bad'
                  : 'sys-health__pill'
          const latCls =
            status === 'bad'
              ? ' sys-health__svc-lat--bad'
              : status === 'deg'
                ? ' sys-health__svc-lat--deg'
                : ''

          return (
            <div
              className="sys-health__row"
              key={service.key}
              data-testid={`system-health-row-${service.key}`}
              data-status={status}
            >
              <div className="sys-health__svc-ico">{service.icon}</div>
              <div className="sys-health__svc-meta">
                <div className="sys-health__svc-name">{service.name}</div>
                <div className="sys-health__svc-host">{service.host}</div>
              </div>
              <div className={`sys-health__svc-lat${latCls}`}>
                {status === 'loading' ? (
                  <span
                    className="sys-health__skel"
                    style={{ width: 46, height: 14 }}
                  />
                ) : latencyMs != null ? (
                  <>
                    {formatLatency(latencyMs)}
                    <span className="unit">ms</span>
                  </>
                ) : (
                  <>
                    —<span className="unit"> n/a</span>
                  </>
                )}
              </div>
              <div className={pillCls}>
                <span className="dot" aria-hidden />
                <span data-testid={`system-health-pill-${service.key}`}>
                  {PILL_LABELS[status]}
                </span>
              </div>
              {status === 'bad' && error && (
                <div
                  className="sys-health__error"
                  data-testid={`system-health-error-${service.key}`}
                >
                  ● {error}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className="sys-health__foot">
        <button
          type="button"
          className={`sys-health__btn sys-health__btn--primary${
            running ? ' sys-health__btn--spinning' : ''
          }`}
          onClick={recheck}
          disabled={running}
          data-testid="system-health-recheck"
        >
          <svg viewBox="0 0 24 24" aria-hidden>
            <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
            <path d="M21 3v5h-5" />
            <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
            <path d="M3 21v-5h5" />
          </svg>
          {running ? 'Checking…' : 'Recheck now'}
        </button>
      </div>
    </section>
  )
}

import { useSuspenseQuery } from '@tanstack/react-query'
import { Link, useRouteContext } from '@tanstack/react-router'
import { useState, type ComponentType, type ReactNode } from 'react'
import { accountPlayersQuery, sessionQuery } from '../../api/queries'
import { QueryBoundary } from '../../components/QueryBoundary'
import { dashboard, type Dashboard } from './dashboard'
import './dashboard.css'
import { OptionA, OptionASkeleton } from './OptionA'
import { OptionB, OptionBSkeleton } from './OptionB'
import { OptionC, OptionCSkeleton } from './OptionC'
import { sample, sampleLabels } from './samples'
import { SAMPLES, VARIANTS, type Sample, type Variant } from './search'

const OPTIONS: Record<Variant, { label: string; View: ComponentType<{ dashboard: Dashboard; now: Date }>; Skeleton: ComponentType }> = {
  a: { label: 'A · Results', View: OptionA, Skeleton: OptionASkeleton },
  b: { label: 'B · Your game', View: OptionB, Skeleton: OptionBSkeleton },
  c: { label: 'C · Day by day', View: OptionC, Skeleton: OptionCSkeleton },
}

// The prototype's switcher between the current Home and each option, and
// between the account's own data and made-up players. Each choice is in the
// URL, so a link opens the same view.
export function OptionSwitcher({ variant, sample }: { variant?: Variant; sample?: Sample }) {
  return (
    <div className="dash-switch" role="group" aria-label="Dashboard prototype">
      <span className="meta">Dashboard prototype</span>
      <nav className="dash-switch__seg" aria-label="Dashboard option">
        <SwitchLink search={{ variant: undefined, sample: undefined }}>
          Current
        </SwitchLink>
        {VARIANTS.map((v) => (
          <SwitchLink key={v} search={{ variant: v, sample }}>
            {OPTIONS[v].label}
          </SwitchLink>
        ))}
      </nav>
      {variant && (
        <nav className="dash-switch__seg" aria-label="Data">
          <SwitchLink search={{ variant, sample: undefined }}>
            Your data
          </SwitchLink>
          {SAMPLES.map((s) => (
            <SwitchLink key={s} search={{ variant, sample: s }}>
              {sampleLabels[s]}
            </SwitchLink>
          ))}
        </nav>
      )}
    </div>
  )
}

// The router marks the open link. Every key is given, so `undefined` must
// match a missing param and "Current" isn't open beside an option.
function SwitchLink({ search, children }: { search: { variant: Variant | undefined; sample: Sample | undefined }; children: ReactNode }) {
  return (
    <Link to="/" search={search} activeOptions={{ includeSearch: true, explicitUndefined: true }}>
      {children}
    </Link>
  )
}

export function DashboardOption({ variant, sample }: { variant: Variant; sample?: Sample }) {
  const { Skeleton } = OPTIONS[variant]
  return (
    // Keyed so another option or data set starts its own load and error.
    <QueryBoundary key={`${variant}-${sample}`} skeleton={<Skeleton />}>
      {sample ? <SampleData variant={variant} sample={sample} /> : <AccountData variant={variant} />}
    </QueryBoundary>
  )
}

function AccountData({ variant }: { variant: Variant }) {
  const { api } = useRouteContext({ from: '__root__' })
  const { data: account } = useSuspenseQuery(sessionQuery(api))
  const { data: players } = useSuspenseQuery(accountPlayersQuery(api))
  // Fixed at mount, so "Today" doesn't change under the reader.
  const [now] = useState(() => new Date())
  const { View } = OPTIONS[variant]
  return <View dashboard={dashboard(account, players)} now={now} />
}

function SampleData({ variant, sample: kind }: { variant: Variant; sample: Sample }) {
  const { api } = useRouteContext({ from: '__root__' })
  const { data: session } = useSuspenseQuery(sessionQuery(api))
  const [now] = useState(() => new Date())
  const { account, players } = sample(kind, session, now)
  const { View } = OPTIONS[variant]
  return <View dashboard={dashboard(account, players)} now={now} />
}

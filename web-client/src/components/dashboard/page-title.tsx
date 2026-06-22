import { Plus } from 'lucide-react'

import { Overline } from '@/components/overline'
import { fmtLongDate } from '@/lib/dates'
import { C, UI } from '@/components/dashboard/dashboard-tokens'
import { Shimmer } from '@/components/dashboard/shimmer'

import { Button } from './page-title/button'

export interface PageTitleProps {
  greeting: string
  subtitle?: string
  compact: boolean
  /** While the session is in flight the greeting name is unknown; render a
   * placeholder bar in the heading instead of flashing a bare "Hi" (#286). */
  loading?: boolean
}

export const PageTitle = ({
  greeting,
  subtitle,
  compact,
  loading = false,
}: PageTitleProps) => {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: compact ? 'column' : 'row',
        alignItems: compact ? 'stretch' : 'flex-end',
        marginBottom: 24,
        gap: 16,
      }}
    >
      <div>
        <Overline style={{ marginBottom: 8 }}>
          Dashboard · {fmtLongDate()}
        </Overline>
        <h1
          aria-busy={loading || undefined}
          aria-label={loading ? 'Loading greeting' : undefined}
          style={{
            margin: 0,
            font: `700 ${compact ? 26 : 32}px ${UI}`,
            letterSpacing: '-0.015em',
            color: C.chalk50,
            lineHeight: 1.05,
          }}
        >
          {loading ? (
            <Shimmer
              width={compact ? 150 : 200}
              height={compact ? 26 : 32}
              radius={8}
              style={{ display: 'inline-block', verticalAlign: 'middle' }}
            />
          ) : (
            <>
              {greeting}
              <span style={{ color: C.ball500 }}>.</span>
            </>
          )}
        </h1>
        {subtitle && (
          <div style={{ marginTop: 6, font: `400 14px ${UI}`, color: C.chalk300 }}>
            {subtitle}
          </div>
        )}
      </div>
      {!compact && <div style={{ flex: 1 }} />}
      <Button
        kind="secondary"
        size="md"
        iconLeft={<Plus size={16} strokeWidth={1.75} />}
        fullWidth={compact}
        to="/matches/new"
      >
        Log a match
      </Button>
    </div>
  )
}

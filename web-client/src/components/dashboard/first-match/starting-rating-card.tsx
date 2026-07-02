import { Info } from 'lucide-react'

import { Card } from '@/components/dashboard/your-game-row/card'
import { Pill } from '@/components/dashboard/your-game-row/rating-card/pill'
import { C, MONO, UI } from '@/components/dashboard/dashboard-tokens'
import { Overline } from '@/components/overline'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { Progress } from '@/components/ui/progress'

// A brand-new account has no history to summarize and no rated league yet —
// every field below is fixed product copy, not fetched data (see #773).
const SEED_RATING = 1500
const SEED_RD = 350
// A Glicko-2 RD of 350 is the maximum (fully unrated); the confidence meter
// below reads it as a share of that ceiling in the opposite direction — 0% RD
// consumed means 0% confidence, hence a near-empty bar.
const SEED_CONFIDENCE_PERCENT = 16

/** The dashboard's rating card for a brand-new account: the seeded 1500
 * rating, a PROVISIONAL badge, and a collapsible explainer for what that
 * means and why confidence starts low. Entirely static copy — nothing here
 * is fetched, since a zero-match account has no rating history yet. */
export const StartingRatingCard = () => {
  return (
    <Card style={{ minWidth: 0 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <Overline>Current rating</Overline>
        <span
          style={{
            font: `500 11px ${MONO}`,
            letterSpacing: '0.04em',
            color: C.chalk300,
          }}
        >
          0-0 · 0 matches
        </span>
      </div>
      <div
        style={{
          marginTop: 10,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <span
          style={{
            font: `700 34px ${MONO}`,
            fontVariantNumeric: 'tabular-nums',
            color: C.chalk50,
          }}
        >
          {SEED_RATING}
        </span>
        <Pill tone="warn">Provisional</Pill>
      </div>
      <Collapsible>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            aria-label="Why does everyone start at 1500?"
            style={{
              marginTop: 12,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              background: 'transparent',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              font: `500 12px ${UI}`,
              color: C.chalk300,
            }}
          >
            <Info size={14} strokeWidth={2} aria-hidden />
            Everyone starts at 1500 — a placeholder, not a verdict.
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div
            style={{
              marginTop: 10,
              padding: 12,
              borderRadius: 10,
              background: 'rgba(255,255,255,0.03)',
              border: `1px solid ${C.ink600}`,
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'baseline',
                justifyContent: 'space-between',
                marginBottom: 8,
              }}
            >
              <span
                style={{
                  font: `600 10px ${MONO}`,
                  letterSpacing: '0.14em',
                  textTransform: 'uppercase',
                  color: C.chalk300,
                }}
              >
                Confidence
              </span>
              <span
                style={{
                  font: `500 11px ${MONO}`,
                  color: C.chalk300,
                }}
              >
                Low · RD {SEED_RD}
              </span>
            </div>
            <Progress
              value={SEED_CONFIDENCE_PERCENT}
              className="[&_[data-slot=progress-indicator]]:bg-[color:var(--warn)]"
            />
            <p
              style={{
                margin: '10px 0 0',
                font: `400 12px ${UI}`,
                lineHeight: 1.45,
                color: C.chalk300,
              }}
            >
              RD (rating deviation) measures how sure the system is about this
              number — it starts at its widest and narrows as you play rated
              matches.
            </p>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  )
}

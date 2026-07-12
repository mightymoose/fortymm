import { Info } from 'lucide-react'

import { Card } from '@/components/dashboard/your-game-row/card'
import { C, MONO, UI } from '@/components/dashboard/dashboard-tokens'
import { Overline } from '@/components/overline'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'

/**
 * The zero-match dashboard's rating slot: the one true thing there is to say to
 * a player who has never finished a rated match — **you are unrated** — plus an
 * explainer for what ends that (#950).
 *
 * It used to print `1500 · PROVISIONAL` with a confidence meter, every figure of
 * it a hardcoded constant. That number is the strategy's *prior* — joining a
 * league seeds `rating_value = initial_rating_value` on session-mint, before you
 * have played a thing — and `CONTEXT.md` § *Rating* is explicit that a player who
 * has never finished a rated match **has no rating**. Every other surface says so
 * (the profile reads "Unrated", the roster and the leagues card an em dash, the
 * opponent picker no rating at all); the dashboard alone announced a rating the
 * rest of the app contradicted one click away, and the API no longer sends one —
 * `DashboardResponse.rating` is `null` for this player.
 *
 * So: no number, no confidence, no badge. Nothing here is fetched *because there
 * is nothing to fetch* — but nothing here is asserted about the player either.
 * The 1500 is deliberately not re-derived from the API and put back: the seed is
 * `RatingStrategy.initial_rating_value` and a USATT-style ladder sets it
 * differently, so quoting it as "your rating" would be wrong in a second way.
 *
 * The wording matches the profile's `UnratedPanel` on purpose — one voice for
 * one state.
 */
export const UnratedCard = () => {
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
        {/* A record, not a rating: 0-0 is a true statement about a player with no
         * matches, and it is the only figure this card is entitled to. */}
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
          font: `700 30px ${UI}`,
          letterSpacing: '-0.01em',
          color: C.chalk50,
        }}
      >
        Unrated
      </div>
      <p
        style={{
          margin: '6px 0 0',
          font: `400 13px ${UI}`,
          lineHeight: 1.45,
          color: C.chalk300,
        }}
      >
        Finish a rated match to start your rating.
      </p>
      <Collapsible>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            aria-label="How does the ladder work?"
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
            How does the ladder work?
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
            {/* Explains the mechanism without quoting a figure of any kind: no
             * starting number, no RD, no confidence level. Anything numeric here
             * would be a claim about this player that they have not earned. */}
            <p
              style={{
                margin: 0,
                font: `400 12px ${UI}`,
                lineHeight: 1.45,
                color: C.chalk300,
              }}
            >
              Your rating is worked out from the rated matches you finish — win
              against a stronger opponent and it climbs faster. The ladder is
              unsure of you at first and settles as you play, so the early swings
              are the big ones.
            </p>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  )
}

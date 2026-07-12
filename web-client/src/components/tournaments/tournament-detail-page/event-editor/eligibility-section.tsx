import { Filter, Globe, Plus } from 'lucide-react'

import { Button } from '@/components/ui/button'

import { genId } from '../../data/helpers'
import type { PredicateIssues } from '../../data/predicate-validation'
import type { Predicate, TournamentEvent } from '../../data/types'
import { EmptyState } from '../../empty-state'
import { SectionHeader } from '../section-header'
import { PredicateRow } from './eligibility-section/predicate-row'

export interface EligibilitySectionProps {
  event: TournamentEvent
  /** When false (a non-creator), the rule *builder* becomes a rule *list*: each
   * rule reads as a sentence and every mutating affordance is hidden — a viewer
   * gets a rendering of the data, never a disabled form (ADR 0015). */
  canEdit: boolean
  /** What is wrong with the rules, by predicate id — the editor's verdict on the
   * whole draft (`eligibilityIssues`), handed down so each row can show its own
   * share in red. Absent until the organizer has tried to save: a rule they are
   * halfway through typing is not yet wrong. */
  issues?: Record<string, PredicateIssues>
  onChange: (next: TournamentEvent) => void
}

/** The event editor's "Eligibility" tab — a free-form, ANDed rule builder for
 * the creator; for everyone else, the same rules read back as prose. No rules
 * means the event is open to everyone, which reads the same either way. */
export const EligibilitySection = ({
  event,
  canEdit,
  issues,
  onChange,
}: EligibilitySectionProps) => {
  const preds = event.predicates
  const setPreds = (predicates: Predicate[]) => onChange({ ...event, predicates })

  const addRule = () =>
    setPreds([
      ...preds,
      { id: genId('pr'), field: 'rating', op: '<', value: 1500 },
    ])

  return (
    <div className="flex flex-col gap-5" data-testid="eligibility-section">
      <SectionHeader
        title="Eligibility rules"
        // "Empty = open to all" tells the organizer what leaving the builder
        // empty will do — config-speak for someone who cannot empty it. What is
        // true for a reader either way is the first sentence.
        subtitle={
          canEdit
            ? 'Players must satisfy every rule to enter. Empty = open to all.'
            : 'Players must satisfy every rule to enter.'
        }
        action={
          canEdit && (
            <Button variant="outline" size="sm" onClick={addRule}>
              <Plus size={14} />
              Add rule
            </Button>
          )
        }
      />

      {preds.length === 0 ? (
        <EmptyState
          icon={<Globe size={28} />}
          title="Open to all players"
          hint="No restrictions. Anyone in the system can register for this event."
          action={
            canEdit && (
              <Button variant="outline" onClick={addRule}>
                <Plus size={16} />
                Add a rule
              </Button>
            )
          }
        />
      ) : (
        <div className="flex flex-col gap-3">
          {/* Column headers are form furniture: they label the controls beneath
              them, and a viewer has none.

              They are also *columns*, and below `sm` the rows they head are stacked
              (`PredicateRow`) — so there are no columns to head, and three words in a
              row of their own would label nothing. Hidden there; every control keeps
              its own `aria-label` regardless, which is what a screen reader reads. */}
          {canEdit && (
            <div
              data-testid="predicate-column-headers"
              className="hidden gap-2 pb-1 text-[11px] font-semibold tracking-[0.12em] text-[color:var(--fg-3)] uppercase sm:grid sm:grid-cols-[160px_180px_1fr_auto]"
            >
              <div>Field</div>
              <div>Operator</div>
              <div>Value</div>
              <div />
            </div>
          )}
          {preds.map((p, i) => (
            <PredicateRow
              key={p.id}
              predicate={p}
              canEdit={canEdit}
              issues={issues?.[p.id]}
              onChange={(np) =>
                setPreds(preds.map((x, j) => (j === i ? np : x)))
              }
              onRemove={() => setPreds(preds.filter((_, j) => j !== i))}
            />
          ))}
          <div
            data-testid="eligibility-footnote"
            className="mt-1 flex items-center gap-2.5 rounded-[6px] border border-[color:rgba(255,122,26,0.2)] bg-[color:var(--bg-accent-soft)] px-3.5 py-2.5"
          >
            <Filter size={14} className="text-[color:var(--ball-500)]" />
            <span className="text-[13px] text-[color:var(--fg-2)]">
              All{' '}
              <strong className="text-[color:var(--fg-1)]">{preds.length}</strong>{' '}
              {preds.length === 1 ? 'rule' : 'rules'} must match.
              {/* How the builder combines them is the organizer's concern; a
                  reader only needs to know that all of them apply. */}
              {canEdit && (
                <>
                  {' '}
                  Combine with{' '}
                  <code className="font-mono text-[color:var(--ball-500)]">
                    AND
                  </code>
                  .
                </>
              )}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

import { Filter, Globe, Plus } from 'lucide-react'

import { Button } from '@/components/ui/button'

import { genId } from '../../data/helpers'
import type { Predicate, TournamentEvent } from '../../data/types'
import { EmptyState } from '../../empty-state'
import { SectionHeader } from '../section-header'
import { PredicateRow } from './eligibility-section/predicate-row'

export interface EligibilitySectionProps {
  event: TournamentEvent
  onChange: (next: TournamentEvent) => void
}

/** The event editor's "Eligibility" tab — a free-form, ANDed rule builder.
 * No rules means the event is open to everyone. */
export const EligibilitySection = ({
  event,
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
    <div className="flex flex-col gap-5">
      <SectionHeader
        title="Eligibility rules"
        subtitle="Players must satisfy every rule to enter. Empty = open to all."
        action={
          <Button variant="outline" size="sm" onClick={addRule}>
            <Plus size={14} />
            Add rule
          </Button>
        }
      />

      {preds.length === 0 ? (
        <EmptyState
          icon={<Globe size={28} />}
          title="Open to all players"
          hint="No restrictions. Anyone in the system can register for this event."
          action={
            <Button variant="outline" onClick={addRule}>
              <Plus size={16} />
              Add a rule
            </Button>
          }
        />
      ) : (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-[160px_180px_1fr_auto] gap-2 pb-1 text-[11px] font-semibold tracking-[0.12em] text-[color:var(--fg-3)] uppercase">
            <div>Field</div>
            <div>Operator</div>
            <div>Value</div>
            <div />
          </div>
          {preds.map((p, i) => (
            <PredicateRow
              key={p.id}
              predicate={p}
              onChange={(np) =>
                setPreds(preds.map((x, j) => (j === i ? np : x)))
              }
              onRemove={() => setPreds(preds.filter((_, j) => j !== i))}
            />
          ))}
          <div className="mt-1 flex items-center gap-2.5 rounded-[6px] border border-[color:rgba(255,122,26,0.2)] bg-[color:var(--bg-accent-soft)] px-3.5 py-2.5">
            <Filter size={14} className="text-[color:var(--ball-500)]" />
            <span className="text-[13px] text-[color:var(--fg-2)]">
              All{' '}
              <strong className="text-[color:var(--fg-1)]">{preds.length}</strong>{' '}
              {preds.length === 1 ? 'rule' : 'rules'} must match. Combine with{' '}
              <code className="font-mono text-[color:var(--ball-500)]">AND</code>.
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

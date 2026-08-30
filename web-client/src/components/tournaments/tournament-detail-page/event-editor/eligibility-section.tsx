import { type Control, useFieldArray } from 'react-hook-form'
import { Filter, Globe, Plus } from 'lucide-react'

import { Button } from '@/components/ui/button'

import { genId } from '../../data/helpers'
import type { PredicateIssues } from '../../data/predicate-validation'
import type { Predicate } from '../../data/types'
import { EmptyState } from '../../empty-state'
import type { EventFormValues } from '../event-form'
import { SectionHeader } from '../section-header'
import { PredicateRow } from './eligibility-section/predicate-row'

export interface EligibilitySectionProps {
  /** The editor's React-Hook-Form control. The predicate list is a
   * `useFieldArray` on this same form, so adding, editing and removing a rule
   * is form state validated by the one `eventSchema` on save (chore 1e). */
  control: Control<EventFormValues>
  /** When false (a non-creator), the rule *builder* becomes a rule *list*: each
   * rule reads as a sentence and every mutating affordance is hidden — a viewer
   * gets a rendering of the data, never a disabled form (ADR 0015). */
  canEdit: boolean
  /** What is wrong with the rules, by predicate id — the editor's verdict on the
   * whole form (`eligibilityIssues`, the same validator `eventSchema` gates the
   * submit with), handed down so each row can show its own share in red under the
   * control that holds it. Absent until the organizer has tried to save: a rule they
   * are halfway through typing is not yet wrong. */
  issues?: Record<string, PredicateIssues>
}

/** The event editor's "Eligibility" tab — a free-form, ANDed rule builder for
 * the creator; for everyone else, the same rules read back as prose. No rules
 * means the event is open to everyone, which reads the same either way. With
 * rules, both voices state the policy truthfully (ADR-0783 §3): the rules bind
 * players rated on this tournament's ladder, and an unrated player is exempt
 * from every one of them (#1608). */
export const EligibilitySection = ({
  control,
  canEdit,
  issues,
}: EligibilitySectionProps) => {
  // `keyName: 'rhfKey'` keeps the field array's internal key off our domain
  // `id`, so the row is keyed on the stable `id` and an in-place `update`
  // re-renders it rather than remounting it (which would drop input focus).
  const { fields, append, remove, update } = useFieldArray({
    control,
    name: 'predicates',
    keyName: 'rhfKey',
  })

  const addRule = () =>
    append({ id: genId('pr'), field: 'rating', op: '<', value: 1500 })

  return (
    <div className="flex flex-col gap-5" data-testid="eligibility-section">
      <SectionHeader
        title="Eligibility rules"
        // "Empty = open to all" tells the organizer what leaving the builder
        // empty will do — config-speak for someone who cannot empty it. What is
        // true for a reader either way is the first sentence.
        //
        // Once a rule exists, the sentence names who it binds: the rules
        // constrain players RATED ON THIS TOURNAMENT'S LADDER, and an unrated
        // player passes every one of them (ADR-0783 §3) — an unqualified
        // "players must satisfy every rule" is the lie #1608 exists to correct.
        // The ladder qualifier is not decoration: the server compares against
        // the rating on this tournament's league, so a player rated elsewhere is
        // unrated here. With no rules the sentence stays as it is: a
        // rated/unrated distinction would qualify an event that is simply open
        // to all.
        subtitle={
          fields.length === 0
            ? canEdit
              ? 'Players must satisfy every rule to enter. Empty = open to all.'
              : 'Players must satisfy every rule to enter.'
            : canEdit
              ? "Players rated on this tournament's ladder must satisfy every rule to enter. Empty = open to all."
              : "Players rated on this tournament's ladder must satisfy every rule to enter."
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

      {fields.length === 0 ? (
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
          {fields.map((field, i) => {
            // A clean domain predicate (no `rhfKey`) so an edit never writes the
            // field array's internal key back into form state.
            const predicate: Predicate = {
              id: field.id,
              field: field.field,
              op: field.op,
              value: field.value,
            }
            return (
              <PredicateRow
                key={field.id}
                predicate={predicate}
                canEdit={canEdit}
                issues={issues?.[field.id]}
                onChange={(np) => update(i, np)}
                onRemove={() => remove(i)}
              />
            )
          })}
          <div
            data-testid="eligibility-footnote"
            className="mt-1 flex items-center gap-2.5 rounded-[6px] border border-[color:rgba(255,122,26,0.2)] bg-[color:var(--bg-accent-soft)] px-3.5 py-2.5"
          >
            <Filter size={14} className="text-[color:var(--ball-500)]" />
            <span className="text-[13px] text-[color:var(--fg-2)]">
              All{' '}
              <strong className="text-[color:var(--fg-1)]">
                {fields.length}
              </strong>{' '}
              {fields.length === 1 ? 'rule applies' : 'rules apply'}{' '}
              {"to players rated on this tournament's ladder."}
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
              )}{' '}
              {/* The exception the rule count alone would erase: an unrated
                  player passes every one of these rules (ADR-0783 §3), so the
                  exemption is stated beside the constraint, in text, never left
                  to a color, an icon or a hover (#1608). "Exempt", not "may
                  enter": these rules are the only thing being spoken for, and
                  capacity and the registration window still refuse on their own
                  terms. */}
              Unrated players are exempt.
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

import { useState } from 'react'
import { Check } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'

import type { Address, Tournament } from '../data/types'
import { Field } from '../field'
import { SectionHeader } from './section-header'

export interface DetailsTabProps {
  tournament: Tournament
  /** When false (a non-creator), the tab renders the tournament's details as
   * values rather than as a disabled form: no controls, no Save (ADR 0015). */
  canEdit: boolean
  onUpdate: (tournament: Tournament) => void
}

/** The Details tab: the creator edits the tournament's name, description, and
 * venue address — changes stage in a draft and commit on Save. Everyone else
 * reads the same fields as rendered values (ADR 0015): a viewer gets a rendering
 * of the data, only an editor gets controls.
 *
 * **Status is not here, and is not a field.** It used to be an owner-editable
 * four-way toggle, which offered every illegal jump the lifecycle forbids
 * (draft → archived, live → draft). A status moves only across a guarded edge
 * (ADR-0017), so the one affordance for it is the header's Publish / Start / End
 * button — a picker of all four statuses would be a picker of mostly-409s. The
 * status is still *shown* on this page: it is the badge in the hero.
 *
 * Each row hands `Field` both its control and the value it holds, and passes one
 * `readOnly={!canEdit}`; `Field` picks between them and drops the form's
 * furniture (the asterisk, the hint) with it. There is one mechanism and one
 * flag, not a conditional per call site — a field added here cannot leak a
 * control, an asterisk, or a hint to a reader by forgetting one. */
export const DetailsTab = ({
  tournament,
  canEdit,
  onUpdate,
}: DetailsTabProps) => {
  const [draft, setDraft] = useState<Tournament>(tournament)
  const [seen, setSeen] = useState(tournament)
  // Dirtiness is derivable: the draft diverges from the committed tournament
  // exactly when there are unsaved edits (saving/reverting realign the refs).
  const dirty = draft !== tournament

  // Re-seed the draft when a different tournament loads — adjusting state
  // during render instead of in an effect.
  if (tournament !== seen) {
    setSeen(tournament)
    setDraft(tournament)
  }

  const update = (patch: Partial<Tournament>) =>
    setDraft((d) => ({ ...d, ...patch }))
  const updateAddress = (patch: Partial<Address>) =>
    setDraft((d) => ({ ...d, address: { ...d.address, ...patch } }))
  const save = () => onUpdate(draft)

  /** The address rows are the same shape six times over: an `Input` over the
   * same value, which `Field` renders as text for a reader. */
  const addressField = (
    label: string,
    key: keyof Address,
    className?: string,
  ) => (
    <Field
      label={label}
      key={key}
      readOnly={!canEdit}
      value={draft.address[key]}
      valueClassName={className}
    >
      {(id) => (
        <Input
          id={id}
          className={className}
          value={draft.address[key]}
          onChange={(e) => updateAddress({ [key]: e.target.value })}
        />
      )}
    </Field>
  )

  return (
    <div data-testid="details-tab">
      <SectionHeader
        title="Tournament details"
        subtitle={
          canEdit
            ? 'Edit the basics. Players see this on the public page and registration emails.'
            : 'The basics for this tournament.'
        }
        action={
          canEdit &&
          dirty && (
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setDraft(tournament)}>
                Revert
              </Button>
              <Button onClick={save}>
                <Check size={16} />
                Save changes
              </Button>
            </div>
          )
        }
      />

      <div className="grid grid-cols-2 gap-6">
        <Card className="px-4">
          <div className="flex flex-col gap-4">
            <div className="text-[15px] font-bold text-[color:var(--fg-1)]">
              About
            </div>
            <Field label="Name" required readOnly={!canEdit} value={draft.name}>
              {(id) => (
                <Input
                  id={id}
                  value={draft.name}
                  onChange={(e) => update({ name: e.target.value })}
                />
              )}
            </Field>
            <Field
              label="Description"
              hint="Optional. Shown on the public registration page."
              readOnly={!canEdit}
              value={draft.description}
              // Taller than a single-line row so the value mirrors the textarea
              // it stands in for, and wraps rather than clipping the prose.
              valueClassName="h-auto min-h-10 items-start whitespace-pre-wrap"
            >
              {(id) => (
                <Textarea
                  id={id}
                  rows={4}
                  value={draft.description}
                  placeholder="Two-day open. USATT-sanctioned."
                  onChange={(e) => update({ description: e.target.value })}
                />
              )}
            </Field>
          </div>
        </Card>

        <Card className="px-4">
          <div className="flex flex-col gap-4">
            <div className="text-[15px] font-bold text-[color:var(--fg-1)]">
              Venue &amp; address
            </div>
            {addressField('Venue name', 'venue')}
            {addressField('Street', 'street')}
            <div className="grid grid-cols-[2fr_1fr_1fr] gap-3">
              {addressField('City', 'city')}
              {addressField('Region', 'region')}
              {addressField('Postal', 'postal', 'font-mono')}
            </div>
            {addressField('Country', 'country')}
          </div>
        </Card>
      </div>
    </div>
  )
}

import { useState } from 'react'
import { Check } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { PreviewLocation } from '@/components/maps/preview-location'

import {
  MAX_ADDRESS_COMPONENT,
  type AddressText,
  blankAddress,
} from '../data/helpers'
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
  /** What the six venue boxes show. A tournament with NO venue (CONTEXT.md,
   * "Venue" — `address: null`) is a valid, first-class state, and this is the one
   * place it becomes six empty boxes: an editor needs somewhere to type. The blank
   * stand-in is display state only — it is not written back into the draft unless
   * the organizer actually types (`updateAddress`), so opening the tab does not
   * silently give a venue-less tournament a venue. */
  const address = draft.address ?? blankAddress()
  // Typing into a box on a venue-less tournament STARTS a venue, on the blank
  // stand-in above. Clearing every box again leaves an all-blank `Address` in the
  // DRAFT — which is right, because the boxes must stay on screen to be retyped into
  // — and `toAddressInput` (`../data/api`) turns it back into `address: null` on the
  // way to the wire, the same spelling the create modal sends. The server normalizes
  // too (`SubmittedAddress`), so this is one intent said once rather than a guard.
  const updateAddress = (patch: Partial<Address>) =>
    setDraft((d) => ({ ...d, address: { ...(d.address ?? blankAddress()), ...patch } }))
  const save = () => onUpdate(draft)

  /** The address rows are the same shape six times over: an `Input` over the
   * same value, which `Field` renders as text for a reader.
   *
   * Keyed by the six **text** components only — never `latitude`/`longitude`.
   * Coordinates are geocoded server-side at write time and are read-only on the
   * client (the read `Address` carries them; the write shape does not), so the
   * edit form neither shows nor submits them.
   *
   * Every one of the six is capped at `MAX_ADDRESS_COMPONENT` — the server's
   * `AddressComponent` bound, which the generated schema cannot express, so this
   * is the only place the organizer meets it before the 422 (#1199). It caps the
   * *typing*, not the value: a row that already holds a 680-character venue from
   * before the bound still renders it in full, and can still be shortened. */
  // `keyof AddressText` — the address's six free-text components, which is exactly
  // "everything the edit form touches": `AddressText` is defined as `Address` minus
  // the coordinates, and those are geocoded server-side and never edited here. The
  // local `Exclude<keyof Address, 'latitude' | 'longitude'>` that used to sit at the
  // top of this file was the same type spelled a second time.
  const addressField = (
    label: string,
    key: keyof AddressText,
    className?: string,
  ) => (
    <Field
      label={label}
      key={key}
      readOnly={!canEdit}
      value={address[key]}
      valueClassName={className}
    >
      {(id) => (
        <Input
          id={id}
          className={className}
          maxLength={MAX_ADDRESS_COMPONENT}
          value={address[key]}
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
            {/* Confirm the venue before saving: geocodes the typed address and
                drops a pin. An editor-only affordance (ADR 0015 — hide mutating
                affordances, never disable them) and display-only: it adds no
                coordinates to the update payload (the server geocodes on save). */}
            {canEdit && <PreviewLocation address={address} />}
          </div>
        </Card>
      </div>
    </div>
  )
}

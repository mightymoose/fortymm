import { useState } from 'react'
import { Check } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'

import type { Address, Tournament, TournamentStatus } from '../data/types'
import { Field } from '../field'
import { SectionHeader } from './section-header'

export interface DetailsTabProps {
  tournament: Tournament
  onUpdate: (tournament: Tournament) => void
}

const STATUS_OPTIONS: { value: TournamentStatus; label: string }[] = [
  { value: 'draft', label: 'Draft' },
  { value: 'published', label: 'Published' },
  { value: 'live', label: 'Live' },
  { value: 'archived', label: 'Archived' },
]

/** The Details tab: edit the tournament's name, description, status, and venue
 * address. Changes stage in a draft and commit on Save. */
export const DetailsTab = ({ tournament, onUpdate }: DetailsTabProps) => {
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

  return (
    <div>
      <SectionHeader
        title="Tournament details"
        subtitle="Edit the basics. Players see this on the public page and registration emails."
        action={
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
            <Field label="Name" required>
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
            <Field label="Status">
              {() => (
                <ToggleGroup
                  type="single"
                  value={draft.status}
                  onValueChange={(v) => v && update({ status: v as TournamentStatus })}
                  className="w-fit"
                >
                  {STATUS_OPTIONS.map((o) => (
                    <ToggleGroupItem key={o.value} value={o.value}>
                      {o.label}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              )}
            </Field>
          </div>
        </Card>

        <Card className="px-4">
          <div className="flex flex-col gap-4">
            <div className="text-[15px] font-bold text-[color:var(--fg-1)]">
              Venue &amp; address
            </div>
            <Field label="Venue name">
              {(id) => (
                <Input
                  id={id}
                  value={draft.address.venue}
                  onChange={(e) => updateAddress({ venue: e.target.value })}
                />
              )}
            </Field>
            <Field label="Street">
              {(id) => (
                <Input
                  id={id}
                  value={draft.address.street}
                  onChange={(e) => updateAddress({ street: e.target.value })}
                />
              )}
            </Field>
            <div className="grid grid-cols-[2fr_1fr_1fr] gap-3">
              <Field label="City">
                {(id) => (
                  <Input
                    id={id}
                    value={draft.address.city}
                    onChange={(e) => updateAddress({ city: e.target.value })}
                  />
                )}
              </Field>
              <Field label="Region">
                {(id) => (
                  <Input
                    id={id}
                    value={draft.address.region}
                    onChange={(e) => updateAddress({ region: e.target.value })}
                  />
                )}
              </Field>
              <Field label="Postal">
                {(id) => (
                  <Input
                    id={id}
                    className="font-mono"
                    value={draft.address.postal}
                    onChange={(e) => updateAddress({ postal: e.target.value })}
                  />
                )}
              </Field>
            </div>
            <Field label="Country">
              {(id) => (
                <Input
                  id={id}
                  value={draft.address.country}
                  onChange={(e) => updateAddress({ country: e.target.value })}
                />
              )}
            </Field>
          </div>
        </Card>
      </div>
    </div>
  )
}

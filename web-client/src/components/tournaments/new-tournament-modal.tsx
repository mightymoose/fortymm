import { useState } from 'react'
import { Check } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

import { emptyTournament } from './data/helpers'
import type { Address, Tournament } from './data/types'
import { Field } from './field'

export interface NewTournamentModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreate: (draft: Omit<Tournament, 'id'>) => void
}

/** "New tournament" dialog — captures a name (required) and optional venue
 * address. Dates are derived from events, so they're set later. */
export const NewTournamentModal = ({
  open,
  onOpenChange,
  onCreate,
}: NewTournamentModalProps) => {
  const [draft, setDraft] = useState<Omit<Tournament, 'id'>>(emptyTournament)
  const [wasOpen, setWasOpen] = useState(open)

  // Reset to a blank draft each time the dialog transitions to open —
  // adjusting state during render instead of in an effect.
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setDraft(emptyTournament())
  }

  const valid = draft.name.trim().length > 0
  const setAddress = (patch: Partial<Address>) =>
    setDraft((d) => ({ ...d, address: { ...d.address, ...patch } }))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>New tournament</DialogTitle>
          <DialogDescription>
            You'll set dates when you add events.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3.5">
          <Field label="Name" required>
            {(id) => (
              <Input
                id={id}
                autoFocus
                value={draft.name}
                placeholder="Spring Open 2026"
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              />
            )}
          </Field>

          <div className="my-1 flex items-center gap-3">
            <span className="text-[11px] font-semibold tracking-[0.14em] text-[color:var(--fg-3)] uppercase">
              Venue
            </span>
            <span className="h-px flex-1 bg-[color:var(--border-subtle)]" />
          </div>

          <Field label="Venue name">
            {(id) => (
              <Input
                id={id}
                value={draft.address.venue}
                placeholder="Berkeley TT Club"
                onChange={(e) => setAddress({ venue: e.target.value })}
              />
            )}
          </Field>
          <Field label="Street">
            {(id) => (
              <Input
                id={id}
                value={draft.address.street}
                placeholder="2727 Milvia St"
                onChange={(e) => setAddress({ street: e.target.value })}
              />
            )}
          </Field>
          <div className="grid grid-cols-[2fr_1fr_1fr] gap-3">
            <Field label="City">
              {(id) => (
                <Input
                  id={id}
                  value={draft.address.city}
                  placeholder="Berkeley"
                  onChange={(e) => setAddress({ city: e.target.value })}
                />
              )}
            </Field>
            <Field label="Region">
              {(id) => (
                <Input
                  id={id}
                  value={draft.address.region}
                  placeholder="CA"
                  onChange={(e) => setAddress({ region: e.target.value })}
                />
              )}
            </Field>
            <Field label="Postal">
              {(id) => (
                <Input
                  id={id}
                  value={draft.address.postal}
                  placeholder="94703"
                  className="font-mono"
                  onChange={(e) => setAddress({ postal: e.target.value })}
                />
              )}
            </Field>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!valid} onClick={() => onCreate(draft)}>
            <Check size={16} />
            Create tournament
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

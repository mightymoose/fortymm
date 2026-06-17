import { useState } from 'react'
import { Check, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

import type { TournamentEvent, TournamentTable } from '../data/types'
import { BasicsSection } from './event-editor/basics-section'
import { EligibilitySection } from './event-editor/eligibility-section'
import { MatchSection } from './event-editor/match-section'
import { PoolsSection } from './event-editor/pools-section'

export interface EventEditorProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The event to edit. A new event has an id beginning `new-`. */
  event: TournamentEvent | null
  /** The tables available to this tournament (for the pools tab). */
  tables: TournamentTable[]
  /** When false (a non-creator), the Save and Delete actions are hidden and the
   * editor becomes a read-only view of the event. */
  canEdit: boolean
  onSave: (event: TournamentEvent) => void
  onDelete: (id: string) => void
}

const SECTIONS = [
  { value: 'basics', label: 'Basics' },
  { value: 'eligibility', label: 'Eligibility' },
  { value: 'match', label: 'Match settings' },
  { value: 'pools', label: 'Table pools' },
]

/** The slide-in event editor — a side sheet with four sections (Basics,
 * Eligibility, Match settings, Table pools) over a working draft that only
 * commits on save. */
export const EventEditor = ({
  open,
  onOpenChange,
  event,
  tables,
  canEdit,
  onSave,
  onDelete,
}: EventEditorProps) => {
  const [draft, setDraft] = useState<TournamentEvent | null>(event)
  const [section, setSection] = useState('basics')
  const [seenEvent, setSeenEvent] = useState(event)

  // Re-seed the working draft and reset to the first section whenever the
  // editor is (re)opened on a different event — adjusting state during render
  // rather than in an effect (https://react.dev/learn/you-might-not-need-an-effect).
  if (event !== seenEvent) {
    setSeenEvent(event)
    setDraft(event)
    setSection('basics')
  }

  const isNew = !event || event.id.startsWith('new')

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full gap-0 p-0 sm:max-w-[820px]"
      >
        <SheetHeader className="border-b border-[color:var(--border-subtle)]">
          <SheetDescription className="text-[11px] font-semibold tracking-[0.14em] uppercase">
            {isNew ? 'New event' : 'Edit event'}
          </SheetDescription>
          <SheetTitle className="truncate text-[20px]">
            {draft?.name || 'Untitled event'}
          </SheetTitle>
        </SheetHeader>

        {draft && (
          <div className="flex-1 overflow-y-auto px-6 py-5">
            <Tabs value={section} onValueChange={setSection}>
              <TabsList className="mb-6 w-full">
                {SECTIONS.map((s) => (
                  <TabsTrigger key={s.value} value={s.value} className="flex-1">
                    {s.label}
                  </TabsTrigger>
                ))}
              </TabsList>
              <TabsContent value="basics">
                <BasicsSection event={draft} onChange={setDraft} />
              </TabsContent>
              <TabsContent value="eligibility">
                <EligibilitySection event={draft} onChange={setDraft} />
              </TabsContent>
              <TabsContent value="match">
                <MatchSection event={draft} onChange={setDraft} />
              </TabsContent>
              <TabsContent value="pools">
                <PoolsSection event={draft} tables={tables} onChange={setDraft} />
              </TabsContent>
            </Tabs>
          </div>
        )}

        <SheetFooter className="flex-row items-center border-t border-[color:var(--border-subtle)]">
          {canEdit && !isNew && draft && (
            <Button variant="destructive" onClick={() => onDelete(draft.id)}>
              <Trash2 size={16} />
              Delete event
            </Button>
          )}
          <span className="flex-1" />
          {/* A non-creator can only dismiss the read-only view. */}
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {canEdit ? 'Cancel' : 'Done'}
          </Button>
          {canEdit && (
            <Button disabled={!draft} onClick={() => draft && onSave(draft)}>
              <Check size={16} />
              {isNew ? 'Create event' : 'Save changes'}
            </Button>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

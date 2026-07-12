import { useEffect, useState } from 'react'
import { zodResolver } from '@hookform/resolvers/zod'
import { useForm, useWatch } from 'react-hook-form'
import { toast } from 'sonner'
import { Check, Trash2 } from 'lucide-react'

import { ApiError } from '@/api/client'
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
import {
  eventSchema,
  eventToFormValues,
  type EventFormValues,
} from './event-form'

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
  /** Persist the edited event. May be async — the editor awaits it, closes
   * itself only on success, and surfaces a rejection inline (the panel stays
   * open with the typed values intact) rather than closing over a silent
   * failure (#933, #934). */
  onSave: (event: TournamentEvent) => void | Promise<void>
  onDelete: (id: string) => void
}

const SECTIONS = [
  { value: 'basics', label: 'Basics' },
  { value: 'eligibility', label: 'Eligibility' },
  { value: 'match', label: 'Match settings' },
  { value: 'pools', label: 'Table pools' },
]

/** The slide-in event editor — a side sheet with four sections (Basics,
 * Eligibility, Match settings, Table pools) over a React-Hook-Form draft. The
 * form is the single source of truth: the scalar Basics/Match fields are
 * validated against `eventSchema`, and the panel closes **only** once the save
 * resolves. A server rejection maps to an inline error and keeps the panel open
 * with the typed values intact (#933, #934). */
export const EventEditor = ({
  open,
  onOpenChange,
  event,
  tables,
  canEdit,
  onSave,
  onDelete,
}: EventEditorProps) => {
  const [section, setSection] = useState('basics')
  const [seenEvent, setSeenEvent] = useState(event)

  const form = useForm<EventFormValues>({
    resolver: zodResolver(eventSchema),
    defaultValues: eventToFormValues(event),
  })

  // Jump back to the first section whenever the editor is (re)opened on a
  // different event — adjusting state during render rather than in an effect
  // (https://react.dev/learn/you-might-not-need-an-effect).
  if (event !== seenEvent) {
    setSeenEvent(event)
    setSection('basics')
  }

  // Re-seed the form to the new event's values (and clear any prior errors). The
  // sheet stays mounted, so without this a second open would show the last
  // attempt. `form.reset` writes RHF's own store, so it belongs in an effect.
  useEffect(() => {
    form.reset(eventToFormValues(event))
  }, [event, form])

  const isNew = !event || event.id.startsWith('new')

  // The bridged draft the scalar sections read from: the non-editable fields off
  // the event, with every editable field taken from live form state. Editing a
  // scalar section writes back through `applyChange`, so the form stays
  // authoritative. `useWatch` (not `form.watch()`) subscribes reactively and is
  // memoizable. The nested-array sections (Eligibility, Table pools) instead
  // drive the same form directly via `useFieldArray` off `form.control` — their
  // add/edit/remove is form state, not a bridged draft (chore 1e).
  const values = useWatch({ control: form.control })
  const draft: TournamentEvent | null = event
    ? { ...event, ...(values as Partial<TournamentEvent>) }
    : null

  const {
    formState: { errors, isSubmitting, isSubmitted },
  } = form

  const applyChange = (next: TournamentEvent) => {
    // Don't validate until the user has tried to save once — otherwise a new
    // event (whose name starts empty) would flash "required" on the first
    // keystroke in any field. After a rejected submit, re-validate live so the
    // inline errors clear as they're fixed.
    const opts = { shouldDirty: true, shouldValidate: isSubmitted }
    form.setValue('name', next.name, opts)
    form.setValue('format', next.format, opts)
    form.setValue('drawType', next.drawType, opts)
    form.setValue('maxPlayers', next.maxPlayers, opts)
    form.setValue('entryFee', next.entryFee, opts)
    form.setValue('slot', next.slot, opts)
    form.setValue('match', next.match, opts)
  }

  const submit = form.handleSubmit(
    async (formValues) => {
      if (!event) return
      const saved: TournamentEvent = { ...event, ...formValues }
      try {
        await onSave(saved)
        onOpenChange(false)
      } catch (err) {
        // A 4xx here is the server refusing a value the client-side schema let
        // through — surface it on the name field (the constrained field an
        // organizer edits) and keep the panel open so nothing is lost (#934).
        if (
          err instanceof ApiError &&
          (err.status === 422 || err.status === 409)
        ) {
          form.setError('name', {
            type: 'server',
            message: err.detail ?? 'The server rejected this event.',
          })
          setSection('basics')
          return
        }
        toast.error("Couldn't save the event", {
          description: err instanceof Error ? err.message : String(err),
        })
      }
    },
    // On a client-side validation failure, jump to Basics so the rejected field
    // (name / player limit / entry fee all live there) is on screen.
    () => setSection('basics'),
  )

  // "Edit event" is an imperative addressed to the person in control. A viewer
  // is not one — the panel is a rendering of the event, so it says so
  // (ADR 0015, rule 5).
  const overline = !canEdit ? 'Event' : isNew ? 'New event' : 'Edit event'

  const basicsErrors = {
    name: errors.name?.message,
    maxPlayers: errors.maxPlayers?.message,
    entryFee: errors.entryFee?.message,
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full gap-0 p-0 sm:w-[820px] sm:max-w-[820px]"
      >
        <SheetHeader className="border-b border-[color:var(--border-subtle)]">
          <SheetDescription
            data-testid="event-editor-overline"
            className="text-[11px] font-semibold tracking-[0.14em] uppercase"
          >
            {overline}
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
                <BasicsSection
                  event={draft}
                  canEdit={canEdit}
                  errors={basicsErrors}
                  onChange={applyChange}
                />
              </TabsContent>
              <TabsContent value="eligibility">
                <EligibilitySection control={form.control} canEdit={canEdit} />
              </TabsContent>
              <TabsContent value="match">
                <MatchSection
                  event={draft}
                  canEdit={canEdit}
                  onChange={applyChange}
                />
              </TabsContent>
              <TabsContent value="pools">
                <PoolsSection
                  control={form.control}
                  tables={tables}
                  canEdit={canEdit}
                />
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
            <Button disabled={!draft || isSubmitting} onClick={submit}>
              <Check size={16} />
              {isNew ? 'Create event' : 'Save changes'}
            </Button>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

import { useState } from 'react'
import { Check, Trash2, TriangleAlert } from 'lucide-react'

import { ApiError } from '@/api/client'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
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

import { eligibilityIssues } from '../data/predicate-validation'
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
  /** Persist the draft. **May be async — and the editor awaits it**: it closes
   * itself only when the promise RESOLVES, and a rejection keeps the sheet open,
   * with the draft intact and the failure on screen. A caller that fires the
   * mutation and closes regardless turns every server refusal into a silently
   * discarded event (the #614 rule, learned again here from a `between` rule with
   * no bounds: a 422 came back, the sheet shut, and everything the organizer had
   * typed went with it). */
  onSave: (event: TournamentEvent) => void | Promise<void>
  onDelete: (id: string) => void
}

/** What the organizer is told when a save is refused.
 *
 * A 4xx is the server saying something *about their event* — the name is too long,
 * a field is out of range — so it is their words that get shown. Anything else (a
 * 5xx, a dropped connection) is about the request, not the event, and gets copy
 * that says so rather than a stack-shaped sentence. Either way it lands INSIDE the
 * sheet: the work is still there, and the message has to be where the work is. */
function saveFailureMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status >= 400 && error.status < 500) {
      return error.detail ?? 'The server rejected this event.'
    }
    return "The server couldn't be reached. Check your connection and try again."
  }
  return 'Something went wrong. Try again.'
}

const SECTIONS = [
  { value: 'basics', label: 'Basics' },
  { value: 'eligibility', label: 'Eligibility' },
  { value: 'match', label: 'Match settings' },
  { value: 'pools', label: 'Table pools' },
]

/** The slide-in event editor — a side sheet with four sections (Basics,
 * Eligibility, Match settings, Table pools) over a working draft that only
 * commits on save.
 *
 * **A save is a request, and a request can be refused.** The two ways the editor
 * takes that seriously:
 *
 * - It *checks the rules first* (`eligibilityIssues`, `data/predicate-validation`)
 *   and refuses to send a draft the server would 422 — a rule with no value, a
 *   `between` with one bound or an inverted pair — pointing the organizer at the
 *   offending row instead. That is a Zod schema mirroring the server's constraints,
 *   which is the house rule for a form (`CLAUDE.md`, `## Forms`).
 * - And when a request is refused *anyway* — an unknown 422, a 5xx, an outage — it
 *   **keeps the sheet open**, keeps the draft, and shows what happened. Client-side
 *   validation only ever prevents the refusals we already know about; this is what
 *   stops the next unknown one from eating somebody's work.
 *
 * Neither the Save button nor the tabs are gated on validity: a disabled Save with
 * no explanation is the dead end ADR-0015 is about (and the repo's Forms convention
 * says the same of `disabled={!isValid}`). Save is live, and pressing it is what
 * produces the red. */
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
  /** Has the organizer *tried* to save? Errors appear on submit, not while a rule
   * is still being typed — a value box that has not been filled in yet is not yet
   * wrong. Once it is true, the messages track the draft live, so fixing a rule
   * clears its message without a second click. */
  const [submitted, setSubmitted] = useState(false)
  /** The server's refusal of the last save, or `null`. Never a reason to close. */
  const [saveFailure, setSaveFailure] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)

  // Re-seed the working draft and reset to the first section whenever the
  // editor is (re)opened on a different event — adjusting state during render
  // rather than in an effect (https://react.dev/learn/you-might-not-need-an-effect).
  if (event !== seenEvent) {
    setSeenEvent(event)
    setDraft(event)
    setSection('basics')
    // A fresh event starts clean: last time's red belongs to last time's draft.
    setSubmitted(false)
    setSaveFailure(null)
  }

  const isNew = !event || event.id.startsWith('new')

  // The verdict on the draft's rules — computed every render, so a fixed rule stops
  // complaining the moment it is fixed. Shown only once `submitted`.
  const issues = draft ? eligibilityIssues(draft.predicates) : {}
  const hasIssues = Object.keys(issues).length > 0

  const save = async () => {
    if (!draft) return

    if (hasIssues) {
      // Refused HERE, so nothing is sent and nothing can be lost. Take them to the
      // rules: the messages are on the Eligibility tab, and a save that failed on a
      // tab you cannot see is indistinguishable from a save that did nothing.
      setSubmitted(true)
      setSection('eligibility')
      setSaveFailure(null)
      return
    }

    setSubmitted(true)
    setSaveFailure(null)
    setIsSaving(true)
    try {
      await onSave(draft)
      // The parent closes the sheet on success. It is the ONLY thing that closes it:
      // a rejection lands in the catch below, with the draft untouched.
    } catch (error) {
      setSaveFailure(saveFailureMessage(error))
    } finally {
      setIsSaving(false)
    }
  }

  // "Edit event" is an imperative addressed to the person in control. A viewer
  // is not one — the panel is a rendering of the event, so it says so
  // (ADR 0015, rule 5).
  const overline = !canEdit ? 'Event' : isNew ? 'New event' : 'Edit event'

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
                  onChange={setDraft}
                />
              </TabsContent>
              <TabsContent value="eligibility">
                <EligibilitySection
                  event={draft}
                  canEdit={canEdit}
                  issues={submitted ? issues : undefined}
                  onChange={setDraft}
                />
              </TabsContent>
              <TabsContent value="match">
                <MatchSection
                  event={draft}
                  canEdit={canEdit}
                  onChange={setDraft}
                />
              </TabsContent>
              <TabsContent value="pools">
                <PoolsSection
                  event={draft}
                  tables={tables}
                  canEdit={canEdit}
                  onChange={setDraft}
                />
              </TabsContent>
            </Tabs>
          </div>
        )}

        {/* The refusal, where the work is. An `Alert` rather than a toast on
            purpose: a toast is a portal that leaves in four seconds, and what it
            would be reporting here is that the sheet in front of you still holds
            unsaved work. It sits above the footer, next to the button that was
            just refused. */}
        {saveFailure && (
          <Alert
            variant="destructive"
            data-testid="event-editor-error"
            className="mx-6 mb-1"
          >
            <TriangleAlert size={16} />
            <AlertTitle>
              {isNew ? "Couldn't create this event" : "Couldn't save your changes"}
            </AlertTitle>
            <AlertDescription>
              {saveFailure} Nothing was saved — your changes are still here.
            </AlertDescription>
          </Alert>
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
            // Disabled only while the save is in the air — never on validity
            // (`CLAUDE.md`, `## Forms`): pressing it is how the organizer finds out
            // what is wrong, and a dead button explains nothing.
            <Button disabled={!draft || isSaving} onClick={save}>
              <Check size={16} />
              {isNew ? 'Create event' : 'Save changes'}
            </Button>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

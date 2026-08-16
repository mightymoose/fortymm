import { useRef, useState } from 'react'
import { zodResolver } from '@hookform/resolvers/zod'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { Plus, Trash2 } from 'lucide-react'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'

import {
  saveFailure,
  saveFailureMessage,
  TOURNAMENT_SAVE_TARGET,
} from '../data/save-failure'
import { addTable, keepTables, tableInUseRefusal } from '../data/table-catalogue'
import type {
  Tournament,
  TournamentTable,
  TournamentTableEntry,
} from '../data/types'
import { SectionHeader } from './section-header'

/** Mirrors the server's boundary: `TournamentTableWrite.label`/`.court` are bare,
 * unconstrained `str` (no `min_length`/`max_length` — the schema drops them
 * entirely, same situation `NewTournamentModal`'s `addressComponent` comment is
 * about), so there is no length bound to mirror. `label` still has to be
 * non-empty — that's a client-only rule the server never states, because an
 * empty key is a well-formed request the server would happily store. `court` is
 * genuinely optional in this UI: the card already renders `Court {court}` with
 * an empty string same as any other, and requiring it here would invent a
 * constraint neither the schema nor the prior `useState` version had. */
const addTableSchema = z.object({
  label: z.string().trim().min(1, { message: 'Label is required.' }),
  court: z.string(),
})

type AddTableValues = z.infer<typeof addTableSchema>

const ADD_TABLE_DEFAULTS: AddTableValues = { label: '', court: '' }

/** The edit a 409 refused, held so the confirm can re-send it **byte for byte** plus
 * the opt-in — which is safe precisely because the refusal wrote nothing (the server
 * judges the whole diff before it moves a row), so there is no partial state to
 * reconcile against first. The `message` is the server's sentence, kept beside the
 * entries because a confirm with no explanation is not a question. */
interface RefusedEdit {
  entries: TournamentTableEntry[]
  message: string
}

export interface TablesTabProps {
  tournament: Tournament
  /** This tournament's table catalogue (the venue tables it owns), as the server
   * sent it — every row carrying the id the server minted for it. */
  catalogue: TournamentTable[]
  /** When false (a non-creator), the add-table form and per-row Remove buttons
   * are hidden, the organizer-voiced half of the subtitle is dropped, and the
   * tab is a read-only list of tables. */
  canEdit: boolean
  /**
   * Persist the next catalogue as the server's **id-keyed diff** (ADR 20260801): a
   * `kept` entry cites a table the tournament already has, an `added` entry has no id
   * for the server to mint one, and a stored table no entry names is **removed**.
   *
   * **The rejection is load-bearing** — this tab awaits it and classifies it. Do not
   * swallow the failure (or attach a global error toast to the mutation behind it):
   * the one refusal that matters here, the 409 on removing a table matches are placed
   * at, is not an error to report but a question to ask, and this component is what
   * asks it.
   */
  onChangeCatalogue: (
    entries: TournamentTableEntry[],
    options: { unplaceFixturesOnRemovedTables: boolean },
  ) => Promise<void>
}

/** The Tables tab: the venue tables in this tournament's catalogue, each with
 * the events using it, plus a form to add a new table. */
export const TablesTab = ({
  tournament,
  catalogue,
  canEdit,
  onChangeCatalogue,
}: TablesTabProps) => {
  const [saving, setSaving] = useState(false)
  const [refused, setRefused] = useState<RefusedEdit | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Radix reports the ACTION click's close through the same `onOpenChange(false)` as
  // Escape and the overlay — remember a confirm so its close is not read as a cancel.
  // Written in the click handler and consumed at the next close, so it re-arms itself
  // (unlike a cleanup-only mounted ref, which StrictMode latches — see
  // `web-client/CLAUDE.md`).
  const confirmed = useRef(false)

  const addTableForm = useForm<AddTableValues>({
    resolver: zodResolver(addTableSchema),
    defaultValues: ADD_TABLE_DEFAULTS,
  })

  const usage = catalogue.map((table) => {
    const usingEvents = tournament.events
      .filter((ev) => ev.reservations.some((r) => r.tableIds.includes(table.id)))
      .map((ev) => ev.name)
    return { table, usingEvents }
  })

  /**
   * Send a catalogue edit and answer whatever comes back. Resolves `true` when the
   * write landed.
   *
   * The 409 branch is deliberately gated on `!unplaceFixturesOnRemovedTables`: a
   * refusal that survives the opt-in is not a question worth re-asking, so it falls
   * through to the inline failure rather than re-opening the dialog the director just
   * answered.
   *
   * `reportFailure` defaults to the tab's own page-level banner (remove-table and the
   * confirm dialog are button-triggered actions, not a form with a field to blame), but
   * the add-table form overrides it with `form.setError('root', ...)` — CLAUDE.md's
   * Forms convention is about a `<form>` with fields, and remove/confirm have none.
   */
  const save = async (
    entries: TournamentTableEntry[],
    unplaceFixturesOnRemovedTables: boolean,
    reportFailure: (message: string) => void = setError,
  ): Promise<boolean> => {
    setError(null)
    setSaving(true)
    try {
      await onChangeCatalogue(entries, { unplaceFixturesOnRemovedTables })
      setRefused(null)
      return true
    } catch (failure) {
      const message = tableInUseRefusal(failure)
      if (message !== null && !unplaceFixturesOnRemovedTables) {
        setRefused({ entries, message })
        return false
      }
      setRefused(null)
      // Everything else is reported in OUR words, from the classification — never the
      // raw `detail` (a 422's message is Pydantic's). The one server sentence this tab
      // shows verbatim is the 409 above, which `saveFailure` also routes through its
      // `refused` arm.
      reportFailure(saveFailureMessage(saveFailure(failure), TOURNAMENT_SAVE_TARGET))
      return false
    } finally {
      setSaving(false)
    }
  }

  /** Remove one table: every OTHER stored table, cited. The removed one is simply
   * absent — an uncited stored table is what a removal *is* on the wire. */
  const removeTable = (id: string) =>
    void save(keepTables(catalogue.filter((t) => t.id !== id)), false)

  /** Add one table: the whole stored catalogue, cited, plus one entry carrying **no
   * id** — the server mints it (ADR 20260801). The form resets only when the write
   * landed, so a refused add leaves the words the organizer typed on screen.
   *
   * `label`/`court` carry no server-mirrored constraint beyond "present" (both are
   * bare, unconstrained `str` on the write schema — see `addTableSchema`), so there is
   * no field this tab could plausibly pin a 422 to: every failure here is a root-level
   * banner, same as `NewTournamentModal`'s non-field-attributable case. */
  const submitTable = addTableForm.handleSubmit(async (values) => {
    addTableForm.clearErrors('root')
    const saved = await save(
      [...keepTables(catalogue), addTable(values.label.trim(), values.court.trim())],
      false,
      (message) => addTableForm.setError('root', { type: 'server', message }),
    )
    if (!saved) return
    addTableForm.reset(ADD_TABLE_DEFAULTS)
  })

  return (
    <div data-testid="tables-tab">
      <SectionHeader
        title="Tables"
        // "Add them to pools when configuring events" is an imperative only the
        // organizer can act on — a reader who cannot edit is told to do
        // something they have no control to do (ADR 0015, rule 5). The
        // descriptive first sentence is true for both voices, so it stays.
        subtitle={
          canEdit
            ? 'The physical tables available at this venue. Add them to pools when configuring events.'
            : 'The physical tables available at this venue.'
        }
      />

      <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
        {usage.map(({ table, usingEvents }) => (
          <Card key={table.id} className="gap-2.5 px-4">
            <div className="flex items-center gap-2.5">
              <div className="relative h-7 w-11 shrink-0 rounded-[3px] border border-[color:rgba(255,122,26,0.3)] bg-[color:var(--bg-accent-soft)]">
                <div className="absolute top-1/2 right-0 left-0 h-px bg-[color:var(--ball-500)] opacity-50" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="font-mono text-[15px] font-bold text-[color:var(--fg-1)]">
                  {table.label}
                </div>
                <div className="text-[11px] text-[color:var(--fg-3)]">
                  Court {table.court}
                </div>
              </div>
              {canEdit && (
                <button
                  type="button"
                  aria-label={`Remove ${table.label}`}
                  onClick={() => removeTable(table.id)}
                  disabled={saving}
                  className="grid size-7 place-items-center rounded-md text-[color:var(--fg-3)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--loss)]"
                >
                  <Trash2 size={14} />
                </button>
              )}
            </div>
            {usingEvents.length > 0 ? (
              <div className="flex flex-wrap gap-1">
                {usingEvents.map((n, i) => (
                  <Badge
                    key={i}
                    variant="ghost"
                    className="border-[color:var(--border-subtle)]"
                  >
                    {n}
                  </Badge>
                ))}
              </div>
            ) : (
              <div className="text-[11px] text-[color:var(--fg-3)] italic">
                Unused
              </div>
            )}
          </Card>
        ))}
      </div>

      {error !== null && (
        <Alert
          variant="destructive"
          data-testid="tables-error"
          className="mt-4 max-w-2xl"
        >
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {canEdit && (
        <div className="mt-6">
          <div className="mb-2 text-[11px] font-semibold tracking-[0.12em] text-[color:var(--fg-3)] uppercase">
            Add a table
          </div>
          <form
            className="flex flex-wrap items-start gap-2"
            onSubmit={submitTable}
            noValidate
          >
            <div>
              <Input
                aria-label="Table label"
                aria-invalid={!!addTableForm.formState.errors.label}
                placeholder="Label (e.g. T9)"
                className="w-36"
                {...addTableForm.register('label')}
              />
              {addTableForm.formState.errors.label && (
                <p className="mt-1.5 text-xs text-[color:var(--loss)]">
                  {addTableForm.formState.errors.label.message}
                </p>
              )}
            </div>
            <Input
              // The card renders "Court {court}", so the field is already
              // labeled "Court" (aria-label) — the value is a bare identifier.
              // Placeholder hints a bare value ("A"), never "Court", so a user
              // following it types "A" → card reads "Court A", not the
              // "Court Court A" a "Court" placeholder would nudge them into.
              aria-label="Court"
              placeholder="e.g. A"
              className="w-28"
              {...addTableForm.register('court')}
            />
            {/* Not gated on form validity: `handleSubmit` already blocks an empty
                label and renders the inline error, so a dead disabled button never
                stands between the organizer and finding out why (web-client/CLAUDE.md,
                "Don't gate the submit button on `formState.isValid`"). */}
            <Button type="submit" disabled={saving}>
              <Plus size={14} />
              Add table
            </Button>
          </form>
          {addTableForm.formState.errors.root && (
            <Alert
              variant="destructive"
              data-testid="add-table-error"
              className="mt-3 max-w-2xl"
            >
              <AlertDescription>
                {addTableForm.formState.errors.root.message}
              </AlertDescription>
            </Alert>
          )}
        </div>
      )}

      {/* The removal's one refusal, asked back as a question (ADR 20260801). The body
          is the SERVER's sentence, verbatim: it names the tables by label, counts the
          matches placed at them, and states both ways out — none of which this client
          can reconstruct, and all of which the director needs to choose between
          unplacing and moving the matches first. */}
      <AlertDialog
        open={refused !== null}
        onOpenChange={(next) => {
          if (next) return
          if (!confirmed.current) setRefused(null)
          confirmed.current = false
        }}
      >
        <AlertDialogContent data-testid="confirm-remove-table">
          <AlertDialogHeader>
            <AlertDialogTitle>Remove the table anyway?</AlertDialogTitle>
            <AlertDialogDescription data-testid="confirm-remove-table-detail">
              {refused?.message}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            {/* No onClick of its own: the cancel is reported once, through
                onOpenChange, the same channel Escape and the overlay use — and
                cancelling sends nothing, so the table stays. */}
            <AlertDialogCancel data-testid="confirm-remove-table-cancel">
              Keep the table
            </AlertDialogCancel>
            <AlertDialogAction
              data-testid="confirm-remove-table-confirm"
              variant="destructive"
              disabled={saving}
              onClick={() => {
                if (!refused) return
                confirmed.current = true
                // The SAME entries, plus the opt-in. Not recomputed from
                // `catalogue`: the answer must be to the question that was asked.
                void save(refused.entries, true)
              }}
            >
              Remove and unplace
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

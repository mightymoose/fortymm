import { useEffect } from 'react'
import { zodResolver } from '@hookform/resolvers/zod'
import { useForm } from 'react-hook-form'
import { toast } from 'sonner'
import { z } from 'zod'
import { Check, TriangleAlert } from 'lucide-react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
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
import {
  TOURNAMENT_SAVE_TARGET,
  saveFailure,
  saveFailureMessage,
  type SaveFailure,
} from './data/save-failure'
import type { Tournament } from './data/types'
import { Field } from './field'

export interface NewTournamentModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Persist the draft. May be async — the modal awaits it, closes itself only
   * on success, and surfaces a rejection inline (the dialog stays open) rather
   * than closing over a silent failure. */
  onCreate: (draft: Omit<Tournament, 'id'>) => void | Promise<void>
}

// Mirrors the server's `tournaments.name` constraint (VARCHAR(255)) so the
// over-long name is caught client-side with an inline message instead of a
// bare 422 (#614).
const NAME_MAX = 255

const schema = z.object({
  name: z
    .string()
    .trim()
    .min(1, { message: 'Name is required.' })
    .max(NAME_MAX, {
      message: `Name must be ${NAME_MAX} characters or fewer.`,
    }),
  venue: z.string(),
  street: z.string(),
  city: z.string(),
  region: z.string(),
  postal: z.string(),
})

type FormValues = z.infer<typeof schema>

const DEFAULT_VALUES: FormValues = {
  name: '',
  venue: '',
  street: '',
  city: '',
  region: '',
  postal: '',
}

/**
 * The wire's field names → the box in *this* form that holds them.
 *
 * Only `name` has one. The five address boxes travel nested under a single `address`
 * (`loc: ["body", "address", "postal"]`, of which `validationFields` keeps `address`),
 * so a complaint about one of them is not a complaint this form can pin to a box —
 * it goes to the banner, which names the Venue address block in the dialog's own
 * words. A true sentence about the right block beats a red message under the wrong
 * box.
 */
const FORM_FIELD: Partial<Record<string, keyof FormValues>> = { name: 'name' }

/** The first refused field this form actually shows, or `null` — for a refusal that
 * named none of them (or named nothing at all), in which case the dialog says so in
 * the banner rather than reddening a box the server never mentioned. */
function refusedFormField(failure: SaveFailure): keyof FormValues | null {
  if (failure.kind !== 'invalid') return null
  for (const field of failure.fields) {
    const formField = FORM_FIELD[field]
    if (formField) return formField
  }
  return null
}

/** "New tournament" dialog — captures a name (required) and optional venue
 * address. Dates are derived from events, so they're set later.
 *
 * It mirrors every constraint the server actually has on what it sends (`name` is
 * `VARCHAR(255)` and `NOT NULL`; the address is six unconstrained JSONB strings), so
 * the refusals we already know about are caught here, with a message under the box.
 * A 422 that gets through is therefore a rule the client did not know to mirror — and
 * it is answered **in the client's own words** (`data/save-failure`, the same
 * classifier and copy table the event editor uses), never by reading Pydantic's prose
 * back to the organizer. The dialog stays open over their entry either way. */
export const NewTournamentModal = ({
  open,
  onOpenChange,
  onCreate,
}: NewTournamentModalProps) => {
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: DEFAULT_VALUES,
    mode: 'onChange',
  })
  const {
    register,
    formState: { errors },
  } = form

  // Reset to a blank draft each time the dialog (re)opens — the modal stays
  // mounted, so without this a second open would show the prior attempt.
  useEffect(() => {
    if (open) form.reset(DEFAULT_VALUES)
  }, [open, form])

  const submit = form.handleSubmit(async (values) => {
    const base = emptyTournament()
    // Last attempt's banner belongs to last attempt (a field's red clears itself:
    // `mode: 'onChange'` re-validates the box as it is retyped).
    form.clearErrors('root')
    try {
      await onCreate({
        ...base,
        name: values.name,
        address: {
          ...base.address,
          venue: values.venue.trim(),
          street: values.street.trim(),
          city: values.city.trim(),
          region: values.region.trim(),
          postal: values.postal.trim(),
        },
      })
      onOpenChange(false)
    } catch (err) {
      // Classify first, word second (`data/save-failure`, ADR-0968) — the SAME
      // classifier and the same copy table the event editor uses. A 422's `detail` is
      // Pydantic's own prose ("String should have at most 255 characters"): machine
      // vocabulary, about a constraint rather than an action, and it must never reach
      // this markup (`DEFINITION_OF_COMPLETE.md`: "Raw API detail strings never reach
      // the UI"). What the wire alone knows — WHICH field it refused — is kept; the
      // sentence is ours.
      const failure = saveFailure(err)
      const message = saveFailureMessage(failure, TOURNAMENT_SAVE_TARGET)
      const field = refusedFormField(failure)
      if (field) {
        // The server blamed a box this form shows: the message goes under it, where
        // the repo's Forms convention puts a field error.
        form.setError(field, { type: 'server', message })
        return
      }
      if (failure.kind === 'invalid' || failure.kind === 'refused') {
        // A 4xx we cannot pin to one box (a nested address field, a 403, a 409):
        // inline on the dialog, which stays open over the organizer's entry.
        form.setError('root', { type: 'server', message })
        return
      }
      // A 5xx or a dead connection — nothing they typed. Toast it (per the Forms
      // convention) and keep the dialog open so the entry isn't lost. In OUR words:
      // an `ApiError`'s `message` is the server's `detail`, which is how the raw
      // string used to get out this way too.
      toast.error("Couldn't create the tournament", { description: message })
    }
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>New tournament</DialogTitle>
          <DialogDescription>
            You'll set dates when you add events.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} noValidate>
          <div className="flex flex-col gap-3.5">
            <Field
              label="Name"
              required
              error={!!errors.name}
              hint={errors.name?.message}
            >
              {(id) => (
                <Input
                  id={id}
                  autoFocus
                  aria-invalid={!!errors.name}
                  placeholder="Spring Open 2026"
                  {...register('name')}
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
                <Input id={id} placeholder="Berkeley TT Club" {...register('venue')} />
              )}
            </Field>
            <Field label="Street">
              {(id) => (
                <Input id={id} placeholder="2727 Milvia St" {...register('street')} />
              )}
            </Field>
            <div className="grid grid-cols-[2fr_1fr_1fr] gap-3">
              <Field label="City">
                {(id) => (
                  <Input id={id} placeholder="Berkeley" {...register('city')} />
                )}
              </Field>
              <Field label="Region">
                {(id) => <Input id={id} placeholder="CA" {...register('region')} />}
              </Field>
              <Field label="Postal">
                {(id) => (
                  <Input
                    id={id}
                    placeholder="94703"
                    className="font-mono"
                    {...register('postal')}
                  />
                )}
              </Field>
            </div>
          </div>

          {/* The refusal the form cannot pin to one box. An `Alert`, not a toast:
              what it reports is that the dialog in front of you still holds
              unsaved work, and a toast is a portal that leaves in four seconds.
              Every word of it is ours (`saveFailureMessage`). */}
          {errors.root && (
            <Alert
              variant="destructive"
              data-testid="new-tournament-error"
              className="mt-4"
            >
              <TriangleAlert size={16} />
              <AlertTitle>Couldn't create this tournament</AlertTitle>
              <AlertDescription>
                {errors.root.message} Nothing was saved — your entry is still
                here.
              </AlertDescription>
            </Alert>
          )}

          <DialogFooter className="mt-6">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            {/* Not gated on form validity: handleSubmit already blocks an
                invalid submit and renders the inline error, so an empty/over-long
                name surfaces a message instead of a dead, disabled button. */}
            <Button type="submit" disabled={form.formState.isSubmitting}>
              <Check size={16} />
              Create tournament
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

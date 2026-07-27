import { useEffect } from 'react'
import { zodResolver } from '@hookform/resolvers/zod'
import { useForm, useWatch } from 'react-hook-form'
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
import { PreviewLocation } from '@/components/maps/preview-location'

import {
  MAX_ADDRESS_COMPONENT,
  blankAddress,
  emptyTournament,
  hasVenue,
} from './data/helpers'
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
  // Mirrors the server's `AddressComponent` bound (255) the same way `name`
  // mirrors `tournaments.name` — and it is the *only* client-side statement of
  // it, since the generated schema drops `maxLength` entirely
  // (`MAX_ADDRESS_COMPONENT`). Without it the organizer's feedback on an
  // over-long venue is a nested-address 422 that this form cannot even pin to a
  // box (`FORM_FIELD` maps `name` alone), i.e. the banner (#1199).
  venue: z.string().max(MAX_ADDRESS_COMPONENT, {
    message: `Venue name must be ${MAX_ADDRESS_COMPONENT} characters or fewer.`,
  }),
  street: z.string(),
  city: z.string(),
  region: z.string(),
  postal: z.string(),
})

type FormValues = z.infer<typeof schema>

/** The country a venue typed in this dialog is assumed to be in. The dialog has no
 * country box (the edit form does), so a venue created here would otherwise reach
 * the geocoder without one.
 *
 * It is applied ONLY to a venue the organizer actually typed. Folded in
 * unconditionally it would turn "no venue" into a venue whose sole content is the
 * word USA — an address the server would dutifully geocode, pinning a tournament
 * with no venue at the middle of the country. */
const DEFAULT_COUNTRY = 'USA'

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
 * back to the organizer. The dialog stays open over their entry either way.
 *
 * And **every** way this can fail says something. Not just the 422: a 403, a 409, a
 * 5xx, a dead network and an unclassifiable bug all land on the same banner, beside
 * the entry they preserved. A failure the UI does not report is a click that did
 * nothing. */
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
    control,
    formState: { errors },
  } = form

  // Live address values, so the "Preview location" pin geocodes exactly what the
  // organizer has typed at click time. This form has no country field (the edit
  // form does), so the previewer composes the five it holds.
  const [venue, street, city, region, postal] = useWatch({
    control,
    name: ['venue', 'street', 'city', 'region', 'postal'],
  })

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
    const typed = {
      venue: values.venue.trim(),
      street: values.street.trim(),
      city: values.city.trim(),
      region: values.region.trim(),
      postal: values.postal.trim(),
    }
    try {
      await onCreate({
        ...base,
        name: values.name,
        // ALL FIVE BOXES BLANK IS NOT A VENUE — it is the first-class "no venue"
        // state (CONTEXT.md, "Venue"), and this dialog must be able to submit it:
        // organizers announce before the room is booked, and a tournament at
        // somebody's home withholds its address on purpose. So the draft carries
        // `null`, and `draftToCreateBody` sends `address: null` rather than six
        // empty strings dressed up with a default country.
        address: hasVenue(typed)
          ? blankAddress({ ...typed, country: DEFAULT_COUNTRY })
          : null,
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
      // EVERY other failure — a nested-address 422, a 403, a 409, a **5xx**, an
      // outage, a bug of ours — lands on the dialog's own banner. There is no arm
      // left that can end in silence, and that is the point (#783 QA, round three).
      //
      // It used to end in one. The 5xx branch alone was a toast, and a toast is not
      // guaranteed to be anything: it is a portal somewhere else on the page, it
      // leaves after four seconds, and QA watched a real 500 produce **no inline
      // error, no toast, no alert** — the Create button simply went back to idle and
      // the app did nothing. "The user clicked and nothing happened" is never an
      // acceptable end state, and the fix is not a better toast: it is to report the
      // failure *where the unsaved work is*, which is the same contract the 422 has
      // had since round two. One channel, every failure, beside the entry it kept.
      form.setError('root', { type: 'server', message })
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

            <Field
              label="Venue name"
              error={!!errors.venue}
              hint={errors.venue?.message}
            >
              {(id) => (
                <Input
                  id={id}
                  // The hard stop, and the schema above is the guarantee: typing
                  // and pasting are capped here, while the Zod bound still catches
                  // a value that arrived some other way (autofill, a restored
                  // draft) and says so under the box instead of at the server.
                  maxLength={MAX_ADDRESS_COMPONENT}
                  aria-invalid={!!errors.venue}
                  placeholder="Berkeley TT Club"
                  {...register('venue')}
                />
              )}
            </Field>
            {/* The other four components share the venue box's server bound —
                `AddressComponent` applies to all six — so they carry the same
                hard stop. Only `venue` also carries a Zod message today; the
                remaining four would each need their own sentence, and none of
                them is the field an organizer pastes an essay into. */}
            <Field label="Street">
              {(id) => (
                <Input
                  id={id}
                  maxLength={MAX_ADDRESS_COMPONENT}
                  placeholder="2727 Milvia St"
                  {...register('street')}
                />
              )}
            </Field>
            <div className="grid grid-cols-[2fr_1fr_1fr] gap-3">
              <Field label="City">
                {(id) => (
                  <Input
                    id={id}
                    maxLength={MAX_ADDRESS_COMPONENT}
                    placeholder="Berkeley"
                    {...register('city')}
                  />
                )}
              </Field>
              <Field label="Region">
                {(id) => (
                  <Input
                    id={id}
                    maxLength={MAX_ADDRESS_COMPONENT}
                    placeholder="CA"
                    {...register('region')}
                  />
                )}
              </Field>
              <Field label="Postal">
                {(id) => (
                  <Input
                    id={id}
                    maxLength={MAX_ADDRESS_COMPONENT}
                    placeholder="94703"
                    className="font-mono"
                    {...register('postal')}
                  />
                )}
              </Field>
            </div>

            {/* Confirm the venue before saving: geocodes the typed address and
                drops a pin. Display-only — it adds no coordinates to the create
                payload (the server geocodes on save). */}
            <PreviewLocation address={{ venue, street, city, region, postal }} />
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

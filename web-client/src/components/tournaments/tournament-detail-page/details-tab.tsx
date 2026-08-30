import { useEffect, useRef } from 'react'
import { zodResolver } from '@hookform/resolvers/zod'
import { useForm, useWatch } from 'react-hook-form'
import { z } from 'zod'
import { Check, TriangleAlert } from 'lucide-react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { PreviewLocation } from '@/components/maps/preview-location'

import {
  MAX_ADDRESS_COMPONENT,
  type AddressText,
  blankAddress,
  hasVenue,
} from '../data/helpers'
import {
  TOURNAMENT_SAVE_TARGET,
  saveFailure,
  saveFailureMessage,
  type SaveFailure,
} from '../data/save-failure'
import type { Tournament } from '../data/types'
import { Field } from '../field'
import { SectionHeader } from './section-header'

export interface DetailsTabProps {
  tournament: Tournament
  /** When false (a non-creator), the tab renders the tournament's details as
   * values rather than as a disabled form: no controls, no Save (ADR 0015). */
  canEdit: boolean
  /** Persist the draft. **The returned promise is load-bearing** (#1593): the tab
   * awaits it, keeps the draft and its Save affordance over a rejection, and
   * reports every failure inline — so a rejection must reach it rather than being
   * swallowed by a toast. The same contract `onCreateEvent`/`onUpdateEvent` carry
   * to the `EventEditor`. */
  onUpdate: (tournament: Tournament) => Promise<void>
}

// Mirrors the server's `TournamentUpdate` bounds (`api/app/schemas/tournament.py`)
// so the refusals we already know about are caught here, with a message under the
// box, instead of at the server (#1593). `name` maps to a NOT NULL VARCHAR(255)
// column; `description` is capped at 1,024 characters; each `AddressInput`
// component at the shared 255.
const NAME_MAX = 255
const DESCRIPTION_MAX = 1024

/**
 * One address component, bounded — the client's mirror of the server's
 * `AddressComponent` (255), which applies to **all six** components and not just
 * the venue name.
 *
 * The `maxLength` DOM attribute below is a hard stop for **typing and pasting**
 * only; a value that arrives by any other route — browser autofill, a programmatic
 * fill — sails straight past it, so the schema bound remains authoritative before
 * submission (#1593).
 */
const addressComponent = (label: string) =>
  z.string().max(MAX_ADDRESS_COMPONENT, {
    message: `${label} must be ${MAX_ADDRESS_COMPONENT} characters or fewer.`,
  })

const schema = z.object({
  name: z
    .string()
    .trim()
    .min(1, { message: 'Name is required.' })
    .max(NAME_MAX, {
      message: `Name must be ${NAME_MAX} characters or fewer.`,
    }),
  description: z.string().max(DESCRIPTION_MAX, {
    message: `Description must be ${DESCRIPTION_MAX} characters or fewer.`,
  }),
  venue: addressComponent('Venue name'),
  street: addressComponent('Street'),
  city: addressComponent('City'),
  region: addressComponent('Region'),
  postal: addressComponent('Postal'),
  country: addressComponent('Country'),
})

type FormValues = z.infer<typeof schema>

/** The form values a committed tournament seeds: its name, description, and the
 * six address components — the blank stand-in for a venue-less one (`address:
 * null` is display state for the boxes, never written back unless typed into,
 * exactly as the draft state this form replaced behaved). */
function valuesFrom(t: Tournament): FormValues {
  const a = t.address ?? blankAddress()
  return {
    name: t.name,
    description: t.description,
    venue: a.venue,
    street: a.street,
    city: a.city,
    region: a.region,
    postal: a.postal,
    country: a.country,
  }
}

/** Build the draft `Tournament` a save sends — the form's values folded back
 * into the committed tournament.
 *
 * The address keeps the draft semantics the old state-based form had: a
 * venue-ful tournament keeps its stored components (coordinates included — the
 * wire builder `toAddressInput` drops them) under the typed ones; a venue-less
 * one starts a venue only when something was actually typed (`hasVenue`); and an
 * all-blank result is left as the stored all-blank `Address` or `null` either
 * way, which `toAddressInput` normalizes to `address: null` on the wire. */
function draftFrom(t: Tournament, values: FormValues): Tournament {
  const six: AddressText = {
    venue: values.venue,
    street: values.street,
    city: values.city,
    region: values.region,
    postal: values.postal,
    country: values.country,
  }
  return {
    ...t,
    name: values.name,
    description: values.description,
    address:
      t.address || hasVenue(six)
        ? { ...(t.address ?? blankAddress()), ...six }
        : null,
  }
}

/**
 * The wire's field names → the box in *this* form that holds them.
 *
 * Only the two top-level fields the Details tab edits have one. The six address
 * boxes travel nested under a single `address` (`loc: ["body", "address",
 * "postal"]`, of which `validationFields` keeps `address`), so a complaint about
 * one of them is not a complaint this form can pin to a box — it goes to the
 * alert, which names the Venue address block in the form's own words. A true
 * sentence about the right block beats a red message under the wrong box.
 */
const FORM_FIELD: Partial<Record<string, keyof FormValues>> = {
  name: 'name',
  description: 'description',
}

/** The first refused field this form actually shows, or `null` — for a refusal
 * that named none of them (or named nothing at all), in which case the tab says
 * so in the alert rather than reddening a box the server never mentioned. */
function refusedFormField(failure: SaveFailure): keyof FormValues | null {
  if (failure.kind !== 'invalid') return null
  for (const field of failure.fields) {
    const formField = FORM_FIELD[field]
    if (formField) return formField
  }
  return null
}

/** The Details tab: the creator edits the tournament's name, description, and
 * venue address — changes stage in the form and commit on Save. Everyone else
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
 * The editable branch is a React Hook Form + Zod form (`## Forms`), the same
 * shape the "New tournament" dialog is (#1593): the schema mirrors every
 * constraint the server has on what it sends, so the refusals we already know
 * about are caught client-side with a message under the box; a save is awaited
 * (the pending gate stops duplicate submits); and **every** way it can fail says
 * something inline, beside the draft it preserved — a 422 naming a box reddens
 * that box in our words, and every other refusal (a nested-address 422, a 403,
 * a 409, a 5xx, a dead network, a bug) lands on the tab's own alert. A failure
 * the UI does not report is a click that did nothing.
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
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: valuesFrom(tournament),
    // Retyping revalidates the touched box, so a stale field error clears itself
    // as the organizer corrects it — without discarding the other edits.
    mode: 'onChange',
  })
  const {
    register,
    control,
    formState: { errors, isDirty, isSubmitting },
  } = form

  /** The failure alert's own DOM node (#1538 pattern). `submit` does
   * `form.clearErrors('root')` before every attempt and `form.setError('root',
   * ...)` only in the catch, so a fresh `errors.root` arrives on every refusal,
   * including a second back-to-back one — this effect moves focus every time, no
   * mount/unmount tracking needed. The resolver never assigns `root`, so typing
   * after a refusal cannot re-trigger this effect and steal focus back. */
  const failureRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (errors.root) failureRef.current?.focus()
  }, [errors.root])

  /** Re-seed the form when a different/refetched committed tournament arrives —
   * the reconciliation a successful save rides home on (the mutation's
   * invalidation refetch replaces the object). An effect, not the
   * adjust-during-render dance the draft state used: `reset` is a side effect on
   * form state and the DOM, and does not belong in a render. React Query's
   * structural sharing returns a byte-identical payload as the very same object,
   * so an unchanged refetch never wipes the draft.
   *
   * A REF, not state, for the same reason nothing renders from it — it only
   * decides whether this effect resets. */
  const seenRef = useRef(tournament)
  useEffect(() => {
    if (tournament !== seenRef.current) {
      seenRef.current = tournament
      form.reset(valuesFrom(tournament))
    }
  }, [tournament, form])

  /** The refused write, classified and worded in the form's own voice. The draft
   * is untouched — React Hook Form still holds every edit — so Save stays on
   * offer for the retry, and the UI never implies the rejected values committed. */
  const submit = form.handleSubmit(
    async (values) => {
      // Last attempt's banner belongs to last attempt (a field's red clears
      // itself: `mode: 'onChange'` re-validates the box as it is retyped).
      form.clearErrors('root')
      try {
        await onUpdate(draftFrom(tournament, values))
      } catch (err) {
        // Classify first, word second (`data/save-failure`, ADR-0968) — the SAME
        // classifier and the same copy table the event editor uses. A 422's
        // `detail` is Pydantic's own prose ("String should have at most 255
        // characters"): machine vocabulary, about a constraint rather than an
        // action, and it must never reach this markup
        // (`DEFINITION_OF_COMPLETE.md`: "Raw API detail strings never reach the
        // UI"). What the wire alone knows — WHICH field it refused — is kept;
        // the sentence is ours.
        const failure = saveFailure(err)
        const message = saveFailureMessage(failure, TOURNAMENT_SAVE_TARGET)
        const field = refusedFormField(failure)
        if (field) {
          // The server blamed a box this form shows: the message goes under it,
          // where the repo's Forms convention puts a field error.
          form.setError(field, { type: 'server', message })
          return
        }
        // EVERY other failure — a nested-address 422, a 403, a 409, a **5xx**, an
        // outage, a bug of ours — lands on the tab's own alert. There is no arm
        // left that can end in silence (#783 QA, round three).
        form.setError('root', { type: 'server', message })
      }
    },
    // A client-blocked attempt is still an attempt: clear the prior form-level
    // failure here too, so a fresh field error never sits beside a stale banner
    // (#1593). React Hook Form has already focused the first invalid control.
    () => form.clearErrors('root'),
  )

  /** The six venue boxes' live values, so the "Preview location" pin geocodes
   * exactly what the organizer has typed at click time. */
  const [venue, street, city, region, postal, country] = useWatch({
    control,
    name: ['venue', 'street', 'city', 'region', 'postal', 'country'],
  })

  /** The address rows are the same shape six times over: an `Input` over the
   * same value, which `Field` renders as text for a reader. The reader's value
   * comes off the committed tournament; the editor's control is the form's.
   *
   * Keyed by the six **text** components only — never `latitude`/`longitude`.
   * Coordinates are geocoded server-side at write time and are read-only on the
   * client (the read `Address` carries them; the write shape does not), so the
   * edit form neither shows nor submits them.
   *
   * Every one of the six is capped at `MAX_ADDRESS_COMPONENT` — the server's
   * `AddressComponent` bound, which the generated schema cannot express, so the
   * schema above and this attribute are the only places the organizer meets it
   * before the 422 (#1199, #1593). The attribute caps the *typing*, not the
   * value: a row that already holds a 680-character venue from before the bound
   * still renders it in full, and can still be shortened. */
  const addressField = (
    label: string,
    key: keyof AddressText,
    className?: string,
  ) => (
    <Field
      label={label}
      key={key}
      readOnly={!canEdit}
      value={(tournament.address ?? blankAddress())[key]}
      valueClassName={className}
      error={!!errors[key]}
      hint={errors[key]?.message}
    >
      {(id, hintId) => (
        <Input
          id={id}
          className={className}
          maxLength={MAX_ADDRESS_COMPONENT}
          aria-invalid={!!errors[key]}
          aria-describedby={hintId}
          {...register(key)}
        />
      )}
    </Field>
  )

  return (
    <form data-testid="details-tab" onSubmit={submit} noValidate>
      <SectionHeader
        title="Tournament details"
        subtitle={
          canEdit
            ? 'Edit the basics. Players see this on the public page and registration emails.'
            : 'The basics for this tournament.'
        }
        action={
          canEdit &&
          isDirty && (
            <div className="flex gap-2">
              {/* `type="button"` — a bare button inside a form submits it. */}
              <Button
                variant="ghost"
                type="button"
                onClick={() => form.reset(valuesFrom(tournament))}
              >
                Revert
              </Button>
              {/* Not gated on form validity: handleSubmit already blocks an
                  invalid submit and renders the inline error, so an empty or
                  over-long name surfaces a message instead of a dead, disabled
                  button. Disabled while the write is in flight, so one save
                  cannot be submitted twice (#1593). */}
              <Button type="submit" disabled={isSubmitting}>
                <Check size={16} />
                Save changes
              </Button>
            </div>
          )
        }
      />

      {/* The refusal the form cannot pin to one box. An `Alert`, not a toast:
          what it reports is that the draft in front of you still holds unsaved
          work, and a toast is a portal that leaves in four seconds. Every word
          of it is ours (`saveFailureMessage`). */}
      {errors.root && (
        <Alert
          variant="destructive"
          data-testid="details-save-error"
          ref={failureRef}
          tabIndex={-1}
          className="mb-4 focus:ring-3 focus:ring-destructive/50"
        >
          <TriangleAlert size={16} />
          <AlertTitle>Couldn't save your changes</AlertTitle>
          <AlertDescription>
            {errors.root.message} Nothing was saved — your changes are still
            here.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-2 gap-6">
        <Card className="px-4">
          <div className="flex flex-col gap-4">
            <div className="text-[15px] font-bold text-[color:var(--fg-1)]">
              About
            </div>
            <Field
              label="Name"
              required
              readOnly={!canEdit}
              value={tournament.name}
              error={!!errors.name}
              hint={errors.name?.message}
            >
              {(id, hintId) => (
                <Input
                  id={id}
                  aria-invalid={!!errors.name}
                  aria-describedby={hintId}
                  {...register('name')}
                />
              )}
            </Field>
            <Field
              label="Description"
              // The error takes the hint's slot; the normal helper text returns
              // the moment the error clears.
              hint={
                errors.description?.message ??
                'Optional. Shown on the public registration page.'
              }
              error={!!errors.description}
              readOnly={!canEdit}
              value={tournament.description}
              // Taller than a single-line row so the value mirrors the textarea
              // it stands in for, and wraps rather than clipping the prose.
              valueClassName="h-auto min-h-10 items-start whitespace-pre-wrap"
            >
              {(id, hintId) => (
                <Textarea
                  id={id}
                  rows={4}
                  placeholder="Two-day open. USATT-sanctioned."
                  aria-invalid={!!errors.description}
                  aria-describedby={hintId}
                  {...register('description')}
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
            {canEdit && (
              <PreviewLocation
                address={{ venue, street, city, region, postal, country }}
              />
            )}
          </div>
        </Card>
      </div>
    </form>
  )
}

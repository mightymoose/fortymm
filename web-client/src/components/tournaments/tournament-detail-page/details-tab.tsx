import { useEffect, useRef, useState } from 'react'
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
import { exceedsCodePoints } from '../data/code-points'
import {
  TOURNAMENT_SAVE_TARGET,
  saveFailure,
  saveFailureMessage,
  type SaveFailure,
} from '../data/save-failure'
import type { Tournament } from '../data/types'
import { Field } from '../field'
import { LoadLatestDialog } from './load-latest-dialog'
import { SectionHeader } from './section-header'

export interface DetailsTabProps {
  tournament: Tournament
  /** When false (a non-creator), the tab renders the tournament's details as
   * values rather than as a disabled form: no controls, no Save (ADR 0015). */
  canEdit: boolean
  /** Whether Details is the tab in view. The page force-mounts this form and
   * hides it with the `hidden` attribute while another tab is up (#1593), so a
   * slow PATCH can be refused while nothing in it can take focus — a browser
   * refuses to focus into `display: none`, and the unchanged error never
   * re-fires. This flag is the event the panel coming back is: on its false→
   * true edge the retained refusal takes focus, field first, alert otherwise
   * (#1593 review). */
  active: boolean
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
// component at the shared 255. The server does not normalize any of them (no
// trim on the way in), so this schema VALIDATES without TRANSFORMING: the value
// a save submits is the value in the box (#1593 review).
const NAME_MAX = 255
const DESCRIPTION_MAX = 1024

/** One bound, counted the way the server counts it. Zod's `.max` caps a string
 * by UTF-16 code units (`string.length`), but the server's Pydantic bounds cap
 * by Unicode code points: a supplementary character — most emoji, some CJK — is
 * one code point yet two code units, so `.max(255)` would refuse a name of 255
 * emoji, whose `length` is 510 and which the server would take. The count is
 * `exceedsCodePoints`'s, which stops at the first code point past the limit —
 * so re-validating a huge pasted value on every keystroke costs at most the
 * limit, not the value (#1593 review). */
const atMostCodePoints = (max: number, message: string) =>
  z.string().refine((v) => !exceedsCodePoints(v, max), { message })

/**
 * One address component, bounded — the client's mirror of the server's
 * `AddressComponent` (255), which applies to **all six** components and not just
 * the venue name.
 *
 * The bound lives ONLY here, counted the way the server counts it — code
 * points, by `atMostCodePoints`. The boxes carry **no** `maxLength` attribute:
 * it counts UTF-16 code units, so it would refuse, from the keyboard, values
 * the server accepts (128 emoji are 256 units but 128 code points), and the
 * normal typing path would never reach this schema (#1593 review). Whatever
 * route a value arrives by — typed, pasted, autofill, a programmatic fill —
 * the schema bound is what stands before submission.
 */
const addressComponent = (label: string) =>
  atMostCodePoints(
    MAX_ADDRESS_COMPONENT,
    `${label} must be ${MAX_ADDRESS_COMPONENT} characters or fewer.`,
  )

const schema = z.object({
  // No `.trim()` transform: it REPLACED the submitted value, so a save that
  // touched only another field renamed a whitespace-padded stored name to its
  // trimmed form — a rename the server, which does not normalize
  // `TournamentUpdate.name`, would have committed silently (#1593 review).
  // Requiredness mirrors Pydantic's `min_length=1`: only the empty string is
  // refused, while a server-valid whitespace-only stored name remains editable.
  // The box's exact value is still what gets saved. The bounded code-point check
  // remains the FIRST pipeline stage so an enormous whitespace-heavy paste is
  // rejected after `NAME_MAX + 1` pulls (#1593 review).
  name: atMostCodePoints(
    NAME_MAX,
    `Name must be ${NAME_MAX} characters or fewer.`,
  ).pipe(
    z.string().min(1, {
      message: 'Name is required.',
    }),
  ),
  description: atMostCodePoints(
    DESCRIPTION_MAX,
    `Description must be ${DESCRIPTION_MAX} characters or fewer.`,
  ),
  venue: addressComponent('Venue name'),
  street: addressComponent('Street'),
  city: addressComponent('City'),
  region: addressComponent('Region'),
  postal: addressComponent('Postal'),
  country: addressComponent('Country'),
})

type FormValues = z.infer<typeof schema>

/** The Details fields in render order. Besides defining first-error focus, this
 * is the complete committed snapshot that may re-seed the form: Events, Tables,
 * schedule results, and the other query-owned tournament data are deliberately
 * outside it. */
const FIELD_ORDER: (keyof FormValues)[] = [
  'name',
  'description',
  'venue',
  'street',
  'city',
  'region',
  'postal',
  'country',
]

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

/** Whether two committed tournaments seed the same Details form. */
function sameValues(left: FormValues, right: FormValues): boolean {
  return FIELD_ORDER.every((field) => left[field] === right[field])
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
 * the UI does not report is a click that did nothing. The panel is force-mounted
 * while hidden too, so a refusal that lands under another tab waits beside the
 * draft — and takes focus when Details comes back (`active`, #1593 review).
 *
 * Each row hands `Field` both its control and the value it holds, and passes one
 * `readOnly={!canEdit}`; `Field` picks between them and drops the form's
 * furniture (the asterisk, the hint) with it. There is one mechanism and one
 * flag, not a conditional per call site — a field added here cannot leak a
 * control, an asterisk, or a hint to a reader by forgetting one. */
export const DetailsTab = ({
  tournament,
  canEdit,
  active,
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
    formState: { errors, isDirty },
  } = form

  /** The pending-save lock, OUTSIDE React Hook Form's resettable form state
   * (#1593 review). `formState.isSubmitting` lives inside the form, and every
   * `form.reset` — Revert, the reconciliation effect below — wipes it: Save
   * re-opened while the original PATCH was still in flight, and a second one
   * could race it. Component state survives every reset; only this
   * component's own `finally` clears it. */
  const [saving, setSaving] = useState(false)

  /** Which draft the pending save belongs to, as a generation — OUTSIDE React
   * Hook Form's resettable form state for the same reason `saving` is (#1593
   * review). Revert or the reconciliation effect can abandon the snapshot a
   * pending PATCH was sent while it is in flight: the reset makes the form
   * pristine, and an edit made afterwards dirties it again — with NEW work
   * the attempt never sent. Dirtiness alone cannot tell that work from the
   * attempt's own, so the abandoned attempt's refusal would be installed
   * against the new draft: a 422 for the old Name reading as an alert that
   * blames Name beside a form whose Name was restored and whose only edit is
   * the Description (#1593 review). Both resets bump this counter; the
   * attempt captures it on the way out, and its catch installs nothing once
   * it has moved — the organizer's next save, against the draft actually on
   * screen, speaks for itself. */
  const attemptGenRef = useRef(0)
  const submittedRef = useRef<FormValues | null>(null)

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

  /** The refusal that landed while the panel was HIDDEN. The page force-mounts
   * this form across tab switches (#1593), so a slow PATCH can be refused while
   * Events/Tables/Schedule is showing — and both focus routes above die there:
   * `shouldFocus: true` aims at a non-focusable input, and the `errors.root`
   * effect fires against a non-focusable alert. A browser simply refuses to
   * focus into `display: none`, and the unchanged error never re-fires its
   * effect — so the hint the organizer never saw stays unannounced.
   *
   * The `active` prop is the event the panel coming back is. On its false→true
   * edge, re-focus the retained refusal: the first field the form shows an
   * error under, else the alert — the same targets the refusal aimed at, so
   * the non-live hint under the box is finally read out.
   *
   * Scoped to the EDGE, not to every error change, so a live panel never
   * re-runs it: there, the refusal-time focus above already won, and re-firing
   * on an unrelated error clearing would drag the caret out of the box the
   * organizer is typing in. The ref mirrors the prop because the edge is
   * exactly what the deps cannot express; StrictMode's mount double-run sees
   * the same `active` twice and arms it identically. */
  const activeRef = useRef(active)
  useEffect(() => {
    const becameActive = active && !activeRef.current
    activeRef.current = active
    if (!becameActive) return
    const fieldWithError = FIELD_ORDER.find((f) => errors[f])
    if (fieldWithError) {
      form.setFocus(fieldWithError)
    } else if (errors.root) {
      failureRef.current?.focus()
    }
  }, [active, errors, form])

  /** A form-level refusal reports *unsaved* work — "your changes are still
   * here". Undoing the edits by hand makes the draft pristine, which already
   * removes Save and Revert, and the alert would then be all that is left:
   * claiming unsaved changes that no longer exist, with no action to dismiss
   * it. Clear it when the dirtiness clears. `reset` (Revert, reconciliation)
   * already wipes it; this covers undoing by hand (#1593 review). Field errors
   * need no such sweep: `mode: 'onChange'` revalidates a box as it is retyped,
   * so the undo clears the complaint that box raised. The sweep keyed to
   * dirtiness CHANGES cannot catch an error installed after a reset that made
   * the form pristine; the save's catch guards its installs on this same
   * `isDirty` for that (#1593 review).
   *
   * That dirty→pristine edge also abandons a pending attempt's snapshot, even
   * though ordinary typing performs no `form.reset`. Advance the same generation
   * the explicit reset paths do, so a later fresh edit cannot make the old
   * attempt's refusal look relevant again (#1593 review). */
  const dirtyRef = useRef(isDirty)
  useEffect(() => {
    const becamePristine = dirtyRef.current && !isDirty
    dirtyRef.current = isDirty
    if (becamePristine) attemptGenRef.current += 1
    if (!isDirty) form.clearErrors('root')
  }, [isDirty, form])

  /** Dirty drafts retain the snapshot and version they started from. A successful
   * save may adopt its reconciled values while preserving typing after submit;
   * an unrelated refresh or a rejected save cannot reset the draft. Switching
   * tournament IDs always starts a new form. */
  const [baseline, setBaseline] = useState(tournament)
  const [confirmLoad, setConfirmLoad] = useState(false)
  const succeededRef = useRef(false)
  const stale = baseline.detailsVersion !== tournament.detailsVersion
  const resetToSaved = () => {
    attemptGenRef.current += 1
    submittedRef.current = null
    succeededRef.current = false
    setBaseline(tournament)
    form.reset(valuesFrom(tournament))
    setConfirmLoad(false)
  }
  const loadLatest = () => {
    if (!stale || saving) return
    resetToSaved()
  }
  useEffect(() => {
    const committedValues = valuesFrom(tournament)
    if (
      tournament.id !== baseline.id ||
      (tournament !== baseline &&
        (!isDirty ||
          (succeededRef.current &&
            submittedRef.current !== null &&
            sameValues(committedValues, submittedRef.current))))
    ) {
      const submitted = submittedRef.current
      const currentValues = form.getValues()
      const laterFields =
        tournament.id === baseline.id && submitted
          ? FIELD_ORDER.filter(
              (field) => currentValues[field] !== submitted[field],
            )
          : []
      submittedRef.current = null
      succeededRef.current = false
      setBaseline(tournament)
      // The re-seed abandons the snapshot a pending save was sent, exactly as
      // the Revert button does — bump the generation with the reset (#1593
      // review).
      attemptGenRef.current += 1
      form.reset(committedValues)
      // The response commits only the submitted snapshot. Later typing remains
      // a draft against that new baseline, so Revert still means the saved values.
      for (const field of laterFields) {
        form.setValue(field, currentValues[field], {
          shouldDirty: true,
          shouldValidate: true,
        })
      }
    }
  }, [tournament, form, baseline, isDirty, saving])

  /** The refused write, classified and worded in the form's own voice. The draft
   * is untouched — React Hook Form still holds every edit — so Save stays on
   * offer for the retry, and the UI never implies the rejected values committed. */
  const submit = form.handleSubmit(
    // eslint-disable-next-line react-hooks/refs -- this callback runs on the submit event, and its catch after the PATCH settles; it never runs during render, so the ref reads below are event-time, not render-time
    async (values) => {
      // The write is pending from here until the `finally` below — gated on
      // the `saving` state above, which no `form.reset` can clear.
      setSaving(true)
      // The generation this attempt's refusal may still stand beside. A
      // Revert or reconciliation reset before the PATCH settles moves it out
      // from under the attempt (#1593 review).
      const attemptGen = attemptGenRef.current
      succeededRef.current = false
      submittedRef.current = values
      // Last attempt's banner belongs to last attempt (a field's red clears
      // itself: `mode: 'onChange'` re-validates the box as it is retyped).
      form.clearErrors('root')
      try {
        await onUpdate(draftFrom(baseline, values))
        succeededRef.current = attemptGenRef.current === attemptGen
      } catch (err) {
        submittedRef.current = null
        // A refusal is about the draft this attempt SENT, and two guards
        // decide whether the form still holds it. The first is dirtiness:
        // Revert or the reconciliation effect can reset the form while the
        // PATCH is in flight, and the `isDirty` sweep above fires only when
        // dirtiness CHANGES, so it cannot clear an error this catch installs
        // afterwards — the pristine form would keep a "your changes are
        // still here" alert with no Save and no Revert to answer it (#1593
        // review). Guard on the same dirtiness the sweep reads.
        if (!form.formState.isDirty) return
        // The second is the draft's generation, which dirtiness alone cannot
        // serve for: an edit made after such a reset dirties the form again,
        // but with NEW work the attempt never sent. Treating that dirty
        // state as the attempt's would blame the new draft for the abandoned
        // snapshot — a 422 for the old Name reading as an alert that blames
        // Name beside a form whose Name was restored and whose only edit is
        // the Description (#1593 review). A reset moved the generation past
        // the one captured on the way out, so an abandoned attempt says
        // nothing; the next save, started against the draft actually on
        // screen, speaks for itself.
        if (attemptGenRef.current !== attemptGen) return
        if (err instanceof DOMException && err.name === 'TimeoutError') {
          form.setError('root', {
            type: 'timeout',
            message:
              'The save took too long. It may still complete on the server. Your edits are still here; reload to check before trying again.',
          })
          return
        }
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
        if (
          field &&
          // A refusal is about the SNAPSHOT this attempt sent. The boxes stay
          // live during a slow PATCH, so a blamed box that no longer holds
          // the refused value must not be reddened and have focus dragged
          // back to it — that would blame a value the server never saw. The
          // complaint goes to the alert with the rest (#1593 review).
          form.getValues(field) === values[field]
        ) {
          // The server blamed a box this form shows, still holding the value
          // it refused: the message goes under it, where the repo's Forms
          // convention puts a field error — and focus moves there, as it does
          // to the form-level alert, so a screen reader hears the refusal
          // instead of a save that did nothing.
          form.setError(
            field,
            { type: 'server', message },
            { shouldFocus: true },
          )
          return
        }
        // EVERY other failure — a nested-address 422, a 403, a 409, a **5xx**, an
        // outage, a bug of ours — lands on the tab's own alert. There is no arm
        // left that can end in silence (#783 QA, round three).
        form.setError('root', { type: failure.kind, message })
      } finally {
        setSaving(false)
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
   * Every one of the six is bounded at `MAX_ADDRESS_COMPONENT` — the server's
   * `AddressComponent` bound, which the generated schema cannot express, so
   * the zod schema above is the only place the organizer meets it before the
   * 422 (#1199, #1593). The boxes carry no `maxLength`: the DOM attribute
   * counts UTF-16 code units and would stop a value the server accepts from
   * being typed at all (#1593 review), so the code-point schema is the bound —
   * checked at submit and as a box is retyped. The bound caps the *value*,
   * not the display: a row that already holds a 680-character venue from
   * before the bound still renders it in full, and can still be shortened. */
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
      announceError
      error={!!errors[key]}
      hint={errors[key]?.message}
    >
      {(id, hintId) => (
        <Input
          id={id}
          className={className}
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
              {/* `type="button"` — a bare button inside a form submits it. The
                  reset abandons the snapshot a pending PATCH was sent, so it
                  bumps the attempt generation too (#1593 review). */}
              <Button
                variant="ghost"
                type="button"
                onClick={() => {
                  if (stale) setConfirmLoad(true)
                  else resetToSaved()
                }}
              >
                Revert
              </Button>
              {/* Not gated on form validity: handleSubmit already blocks an
                  invalid submit and renders the inline error, so an empty or
                  over-long name surfaces a message instead of a dead, disabled
                  button. Gated on the `saving` lock above — not
                  `formState.isSubmitting`, which a reset mid-flight would
                  clear (#1593) — so one save cannot be submitted twice. */}
              <Button type="submit" disabled={saving}>
                <Check size={16} />
                Save changes
              </Button>
            </div>
          )
        }
      />

      <LoadLatestDialog
        open={confirmLoad}
        onCancel={() => setConfirmLoad(false)}
        onLoad={loadLatest}
      />
      {/* The refusal the form cannot pin to one box. An `Alert`, not a toast:
          what it reports is that the draft in front of you still holds unsaved
          work, and a toast is a portal that leaves in four seconds. Every word
          of it is ours (`saveFailureMessage`). */}
      {(errors.root || (canEdit && stale)) && (
        <Alert
          variant="destructive"
          data-testid="details-save-error"
          ref={failureRef}
          tabIndex={-1}
          className="mb-4 focus:ring-3 focus:ring-destructive/50"
        >
          <TriangleAlert size={16} />
          <AlertTitle>
            {errors.root?.type === 'timeout'
              ? "Couldn't confirm your save"
              : errors.root
                ? "Couldn't save your changes"
                : 'Updated elsewhere'}
          </AlertTitle>
          <AlertDescription>
            {errors.root?.message}
            {errors.root &&
              errors.root.type !== 'timeout' &&
              ' Nothing was saved — your changes are still here.'}
            {canEdit && (stale || errors.root?.type === 'conflict') && (
              <span>
                {stale ? (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={saving}
                    onClick={() => {
                      if (isDirty) setConfirmLoad(true)
                      else loadLatest()
                    }}
                  >
                    Load latest
                  </Button>
                ) : (
                  <span>
                    The latest saved values aren’t available yet. Try saving
                    again to refresh them.
                  </span>
                )}
              </span>
            )}
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
              announceError
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
              announceError
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

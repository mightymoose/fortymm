import { useEffect, useRef, useState } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Check } from 'lucide-react'

import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { PreviewLocation } from '@/components/maps/preview-location'

import {
  MAX_ADDRESS_COMPONENT,
  type AddressText,
  blankAddress,
} from '../data/helpers'
import type { Address, Tournament } from '../data/types'
import { Field } from '../field'
import { SectionHeader } from './section-header'
import {
  saveFailure,
  saveFailureMessage,
  TOURNAMENT_SAVE_TARGET,
  type SaveFailure,
} from '../data/save-failure'
import { LoadLatestDialog } from './load-latest-dialog'

const addressText = z.string().max(MAX_ADDRESS_COMPONENT)
const detailsSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name.').max(255),
  description: z.string().max(1024),
  address: z
    .object({
      venue: addressText,
      street: addressText,
      city: addressText,
      region: addressText,
      postal: addressText,
      country: addressText,
      latitude: z.number(),
      longitude: z.number(),
    })
    .nullable(),
})
type DetailsValues = z.infer<typeof detailsSchema>
const detailsValues = (t: Tournament): DetailsValues => ({
  name: t.name,
  description: t.description,
  address: t.address,
})

export interface DetailsTabProps {
  tournament: Tournament
  /** When false (a non-creator), the tab renders the tournament's details as
   * values rather than as a disabled form: no controls, no Save (ADR 0015). */
  canEdit: boolean
  onUpdate: (tournament: Tournament) => void | Promise<unknown>
}

/** The Details tab: the creator edits the tournament's name, description, and
 * venue address — changes stage in a draft and commit on Save. Everyone else
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
  const [baseline, setBaseline] = useState(tournament)
  const [failure, setFailure] = useState<SaveFailure | null>(null)
  const [confirmLoad, setConfirmLoad] = useState(false)
  const failureRef = useRef<HTMLDivElement>(null)
  const form = useForm<DetailsValues>({
    resolver: zodResolver(detailsSchema),
    defaultValues: detailsValues(tournament),
  })
  const [name, description, draftAddress] = useWatch({
    control: form.control,
    name: ['name', 'description', 'address'],
  })
  const { isDirty: dirty, isSubmitting: saving, errors } = form.formState
  const draft: Tournament = {
    ...baseline,
    name,
    description,
    address: draftAddress,
  }
  const stale = baseline.detailsVersion !== tournament.detailsVersion

  // React state follows a clean read during render; RHF owns an external form store.
  // A dirty draft keeps both its original values and original version.
  if (baseline !== tournament && (!dirty || baseline.id !== tournament.id)) {
    setBaseline(tournament)
    setFailure(null)
  }
  useEffect(() => {
    form.reset(detailsValues(baseline))
  }, [baseline, form])
  useEffect(() => {
    if (failure) failureRef.current?.focus()
  }, [failure])

  const resetToSaved = () => {
    setBaseline(tournament)
    form.reset(detailsValues(tournament))
    setConfirmLoad(false)
    setFailure(null)
  }
  const loadLatest = () => {
    if (!stale) return
    resetToSaved()
  }
  const update = (patch: Partial<DetailsValues>) => {
    const options = {
      shouldDirty: true,
      shouldValidate: form.formState.isSubmitted,
    }
    if (patch.name !== undefined) form.setValue('name', patch.name, options)
    if (patch.description !== undefined)
      form.setValue('description', patch.description, options)
    if (patch.address !== undefined)
      form.setValue('address', patch.address, options)
  }
  const address = draft.address ?? blankAddress()
  const updateAddress = (patch: Partial<Address>) =>
    update({ address: { ...address, ...patch } })
  const save = form.handleSubmit(async (values) => {
    setFailure(null)
    try {
      await onUpdate({ ...baseline, ...values })
      form.reset(values)
    } catch (error) {
      setFailure(saveFailure(error))
    }
  })

  /** The address rows are the same shape six times over: an `Input` over the
   * same value, which `Field` renders as text for a reader.
   *
   * Keyed by the six **text** components only — never `latitude`/`longitude`.
   * Coordinates are geocoded server-side at write time and are read-only on the
   * client (the read `Address` carries them; the write shape does not), so the
   * edit form neither shows nor submits them.
   *
   * Every one of the six is capped at `MAX_ADDRESS_COMPONENT` — the server's
   * `AddressComponent` bound, which the generated schema cannot express, so this
   * is the only place the organizer meets it before the 422 (#1199). It caps the
   * *typing*, not the value: a row that already holds a 680-character venue from
   * before the bound still renders it in full, and can still be shortened. */
  // `keyof AddressText` — the address's six free-text components, which is exactly
  // "everything the edit form touches": `AddressText` is defined as `Address` minus
  // the coordinates, and those are geocoded server-side and never edited here. The
  // local `Exclude<keyof Address, 'latitude' | 'longitude'>` that used to sit at the
  // top of this file was the same type spelled a second time.
  const addressField = (
    label: string,
    key: keyof AddressText,
    className?: string,
  ) => (
    <Field
      label={label}
      key={key}
      readOnly={!canEdit}
      value={address[key]}
      valueClassName={className}
    >
      {(id) => (
        <>
          <Input
            id={id}
            disabled={saving}
            aria-invalid={!!errors.address?.[key]}
            className={className}
            maxLength={MAX_ADDRESS_COMPONENT}
            value={address[key]}
            onChange={(e) => updateAddress({ [key]: e.target.value })}
          />
          {errors.address?.[key] && (
            <p className="text-sm text-destructive">
              {errors.address[key].message}
            </p>
          )}
        </>
      )}
    </Field>
  )

  return (
    <div data-testid="details-tab">
      <SectionHeader
        title="Tournament details"
        subtitle={
          canEdit
            ? 'Edit the basics. Players see this on the public page and registration emails.'
            : 'The basics for this tournament.'
        }
        action={
          canEdit &&
          dirty && (
            <div className="flex gap-2">
              <Button
                variant="ghost"
                disabled={saving}
                onClick={() => {
                  if (stale) setConfirmLoad(true)
                  else resetToSaved()
                }}
              >
                Revert
              </Button>
              <Button onClick={save} disabled={saving}>
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
      {canEdit && (stale || failure) && (
        <Alert className="mb-4" ref={failureRef} tabIndex={-1}>
          <AlertTitle>
            {stale || failure?.kind === 'conflict'
              ? 'Updated elsewhere'
              : 'Couldn’t save your changes'}
          </AlertTitle>
          <AlertDescription>
            {failure
              ? `${saveFailureMessage(failure, TOURNAMENT_SAVE_TARGET)} Nothing was saved — your changes are still here.`
              : 'Your unsaved changes are still here.'}
            {failure?.kind === 'conflict' && !stale && (
              <span>
                The latest saved values aren’t available yet. Try saving again
                to refresh them.
              </span>
            )}
            {stale && (
              <Button
                variant="outline"
                disabled={saving}
                onClick={() => {
                  if (dirty) setConfirmLoad(true)
                  else loadLatest()
                }}
              >
                Load latest
              </Button>
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
            <Field label="Name" required readOnly={!canEdit} value={draft.name}>
              {(id) => (
                <Input
                  id={id}
                  disabled={saving}
                  aria-invalid={!!errors.name}
                  value={draft.name}
                  onChange={(e) => update({ name: e.target.value })}
                />
              )}
            </Field>
            {errors.name && (
              <p className="text-sm text-destructive">{errors.name.message}</p>
            )}
            <Field
              label="Description"
              hint="Optional. Shown on the public registration page."
              readOnly={!canEdit}
              value={draft.description}
              // Taller than a single-line row so the value mirrors the textarea
              // it stands in for, and wraps rather than clipping the prose.
              valueClassName="h-auto min-h-10 items-start whitespace-pre-wrap"
            >
              {(id) => (
                <Textarea
                  id={id}
                  disabled={saving}
                  aria-invalid={!!errors.description}
                  rows={4}
                  value={draft.description}
                  placeholder="Two-day open. USATT-sanctioned."
                  onChange={(e) => update({ description: e.target.value })}
                />
              )}
            </Field>
            {errors.description && (
              <p className="text-sm text-destructive">
                {errors.description.message}
              </p>
            )}
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
            {canEdit && <PreviewLocation address={address} />}
          </div>
        </Card>
      </div>
    </div>
  )
}

import { type Control, useForm, useWatch } from 'react-hook-form'

import { eventToFormValues, type EventFormValues } from '../event-form'
import { EligibilitySection } from './eligibility-section'
import type { EligibilityHarnessInputs } from './eligibility-section.factory'

/** Exposes the form's live `predicates` array as JSON so a test can assert that
 * an add / edit / remove landed in form state. Rendered *outside* the section
 * root, so it is never swept by the read-only guard. */
const PredicatesProbe = ({ control }: { control: Control<EventFormValues> }) => {
  const predicates = useWatch({ control, name: 'predicates' })
  return (
    <output data-testid="predicates-probe">{JSON.stringify(predicates)}</output>
  )
}

/** Wraps `EligibilitySection` in a form seeded from `event` — the section drives
 * a `useFieldArray` off that form's control (chore 1e), so the harness is how a
 * test renders it in isolation and reads back the resulting form state. */
export const EligibilityHarness = ({
  event,
  canEdit,
}: EligibilityHarnessInputs) => {
  const form = useForm<EventFormValues>({
    defaultValues: eventToFormValues(event),
  })
  return (
    <>
      <EligibilitySection control={form.control} canEdit={canEdit} />
      <PredicatesProbe control={form.control} />
    </>
  )
}

import { type Control, useForm, useWatch } from 'react-hook-form'

import { eventToFormValues, type EventFormValues } from '../event-form'
import { PoolsSection } from './pools-section'
import type { PoolsHarnessInputs } from './pools-section.factory'

/** Exposes the form's live `pools` array as JSON so a test can assert that an
 * add / edit / remove landed in form state. Rendered *outside* the section root,
 * so it is never swept by the read-only guard. */
const PoolsProbe = ({ control }: { control: Control<EventFormValues> }) => {
  const pools = useWatch({ control, name: 'pools' })
  return <output data-testid="pools-probe">{JSON.stringify(pools)}</output>
}

/** Wraps `PoolsSection` in a form seeded from `event` — the section drives a
 * `useFieldArray` off that form's control (chore 1e), so the harness is how a
 * test renders it in isolation and reads back the resulting form state. */
export const PoolsHarness = ({
  event,
  tables,
  canEdit,
  freeze,
  nameIssues,
}: PoolsHarnessInputs) => {
  const form = useForm<EventFormValues>({
    defaultValues: eventToFormValues(event),
  })
  return (
    <>
      <PoolsSection
        control={form.control}
        tables={tables}
        canEdit={canEdit}
        freeze={freeze}
        // Handed in, exactly as the editor hands it in — the section renders the verdict
        // it is given and computes none of its own. (Whether the *editor* computes the
        // right one, and refuses the save, is `event-editor.test.tsx`'s claim.)
        nameIssues={nameIssues}
      />
      <PoolsProbe control={form.control} />
    </>
  )
}

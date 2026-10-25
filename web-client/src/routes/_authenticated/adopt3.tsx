import { createFileRoute } from '@tanstack/react-router'
import { Adopt3 } from '../../pages/adopt/Adopt3'
import { validateAdoptSearch } from '../../pages/adopt/scenarios'

export const Route = createFileRoute('/_authenticated/adopt3')({
  validateSearch: validateAdoptSearch,
  component: function Adopt3Route() {
    const { state } = Route.useSearch()
    return <Adopt3 key={state} state={state} />
  },
})

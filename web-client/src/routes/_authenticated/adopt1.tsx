import { createFileRoute } from '@tanstack/react-router'
import { Adopt1 } from '../../pages/adopt/Adopt1'
import { validateAdoptSearch } from '../../pages/adopt/scenarios'

export const Route = createFileRoute('/_authenticated/adopt1')({
  validateSearch: validateAdoptSearch,
  component: function Adopt1Route() {
    const { state } = Route.useSearch()
    return <Adopt1 key={state} state={state} />
  },
})

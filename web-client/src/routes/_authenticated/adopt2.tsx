import { createFileRoute } from '@tanstack/react-router'
import { Adopt2 } from '../../pages/adopt/Adopt2'
import { validateAdoptSearch } from '../../pages/adopt/scenarios'

export const Route = createFileRoute('/_authenticated/adopt2')({
  validateSearch: validateAdoptSearch,
  component: function Adopt2Route() {
    const { state } = Route.useSearch()
    return <Adopt2 key={state} state={state} />
  },
})

import { getRouteApi } from '@tanstack/react-router'
import { ListStatesBar } from './parts'
import { variants } from './variants'
import type { VariantSlug } from './variantSlugs'

const route = getRouteApi('/_authenticated/players/$variant/')

// A mockup of the players list, in the state its `?state=` asks for.
export function PlayersListPage() {
  // The `$variant` route checks the slug before this renders.
  const variant = route.useParams().variant as VariantSlug
  const { state = 'ready' } = route.useSearch()
  const { List } = variants[variant]
  return (
    <>
      <ListStatesBar variant={variant} />
      <List scenario={state} />
    </>
  )
}

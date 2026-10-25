import { getRouteApi } from '@tanstack/react-router'
import { DetailStatesBar } from './parts'
import { variants } from './variants'
import type { VariantSlug } from './variantSlugs'

const route = getRouteApi('/_authenticated/players/$variant/$playerId')

// A mockup of a player's page, in the state its `?state=` asks for. An
// unknown player is the player 404 in every state that answers.
export function PlayerPage() {
  const params = route.useParams()
  // The `$variant` route checks the slug before this renders.
  const variant = params.variant as VariantSlug
  const { state = 'ready' } = route.useSearch()
  const { Detail } = variants[variant]
  return (
    <>
      <DetailStatesBar variant={variant} playerId={params.playerId} />
      <Detail playerId={params.playerId} scenario={state} />
    </>
  )
}

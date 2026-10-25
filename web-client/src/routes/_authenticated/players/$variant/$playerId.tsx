import { createFileRoute } from '@tanstack/react-router'
import { PlayerPage } from '../../../../pages/players/PlayerPage'
import { detailScenarios, scenarioSearch } from '../../../../pages/players/scenarios'

export const Route = createFileRoute('/_authenticated/players/$variant/$playerId')({
  validateSearch: scenarioSearch(detailScenarios),
  component: PlayerPage,
})

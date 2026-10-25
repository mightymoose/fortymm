import { createFileRoute } from '@tanstack/react-router'
import { PlayersListPage } from '../../../../pages/players/PlayersListPage'
import { listScenarios, scenarioSearch } from '../../../../pages/players/scenarios'

export const Route = createFileRoute('/_authenticated/players/$variant/')({
  validateSearch: scenarioSearch(listScenarios),
  component: PlayersListPage,
})

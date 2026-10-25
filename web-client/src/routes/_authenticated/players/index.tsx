import { createFileRoute } from '@tanstack/react-router'
import { PlayersMockups } from '../../../pages/players/PlayersMockups'

export const Route = createFileRoute('/_authenticated/players/')({
  component: PlayersMockups,
})

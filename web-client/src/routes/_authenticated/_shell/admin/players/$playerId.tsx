import { createFileRoute } from '@tanstack/react-router'
import { PlayerAdmin } from '../../../../../pages/admin/PlayerAdmin'

export const Route = createFileRoute('/_authenticated/_shell/admin/players/$playerId')({
  component: PlayerAdmin,
})

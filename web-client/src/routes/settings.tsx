import { createFileRoute } from '@tanstack/react-router'
import { ownAccount } from '../account.ts'
import {
  SettingsScreen,
  SettingsScreenPending,
} from '../components/SettingsScreen.tsx'

export const Route = createFileRoute('/settings')({
  loader: () => ownAccount(),
  pendingComponent: SettingsScreenPending,
  component: SettingsRoute,
})

function SettingsRoute() {
  return <SettingsScreen account={Route.useLoaderData()} />
}

import { createFileRoute } from '@tanstack/react-router'
import { Settings } from '../components/Settings.tsx'
import { SettingsScreenPending } from '../components/SettingsScreen.tsx'
import { userStore } from '../stores/user.ts'

export const Route = createFileRoute('/settings')({
  loader: () => userStore.getState().load(),
  pendingComponent: SettingsScreenPending,
  component: Settings,
})

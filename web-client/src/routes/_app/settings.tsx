import { createFileRoute } from '@tanstack/react-router'
import { SettingsScreen } from '../../components/SettingsScreen.tsx'

export const Route = createFileRoute('/_app/settings')({
  component: SettingsScreen,
})

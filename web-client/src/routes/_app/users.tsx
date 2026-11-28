import { createFileRoute } from '@tanstack/react-router'
import { UsersScreen } from '../../components/UsersScreen.tsx'

export const Route = createFileRoute('/_app/users')({
  component: UsersScreen,
})

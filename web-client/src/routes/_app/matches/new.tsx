import { createFileRoute } from '@tanstack/react-router'
import { NewMatchScreen } from '../../../components/NewMatchScreen.tsx'

export const Route = createFileRoute('/_app/matches/new')({
  component: NewMatchScreen,
})

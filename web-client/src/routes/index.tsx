import { createFileRoute } from '@tanstack/react-router'
import { HomeScreen } from '../components/HomeScreen.tsx'

export const Route = createFileRoute('/')({
  component: HomeScreen,
})

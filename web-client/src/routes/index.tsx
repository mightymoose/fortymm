import { createFileRoute } from '@tanstack/react-router'
import { StartScreen } from '../components/StartScreen.tsx'

export const Route = createFileRoute('/')({
  component: StartScreen,
})

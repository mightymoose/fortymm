import { createFileRoute } from '@tanstack/react-router'
import { OptionsIndex } from '../../pages/options/OptionsIndex'

export const Route = createFileRoute('/options/')({
  component: OptionsIndex,
})

import { createFileRoute } from '@tanstack/react-router'
import { TypeTab } from '../../components/TypeTab.tsx'

export const Route = createFileRoute('/design-system/type')({
  component: TypeTab,
})

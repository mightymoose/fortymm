import { createFileRoute } from '@tanstack/react-router'
import { DesignSystemFormsScreen } from '../../components/design-system/DesignSystemFormsScreen.tsx'

export const Route = createFileRoute('/design-system/forms')({
  component: DesignSystemFormsScreen,
})

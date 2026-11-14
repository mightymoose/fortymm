import { createFileRoute, Outlet } from '@tanstack/react-router'
import { DesignSystemLayout } from '../components/DesignSystemLayout.tsx'

// The design system page's layout: its header and tabs, around the current
// tab, each a route of its own (design-system/*.tsx). /design-system itself
// goes to the first tab (design-system/index.tsx).
export const Route = createFileRoute('/design-system')({
  component: () => (
    <DesignSystemLayout>
      <Outlet />
    </DesignSystemLayout>
  ),
})

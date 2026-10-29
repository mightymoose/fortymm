import { createFileRoute } from '@tanstack/react-router'
import { ShellLayout } from '../../pages/ShellLayout'

// A pathless layout route that puts its pages in AppShell. Authenticated
// pages that stand alone, such as the player review, sit next to it.
export const Route = createFileRoute('/_authenticated/_shell')({
  component: ShellLayout,
})

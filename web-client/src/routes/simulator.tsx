import { createFileRoute } from '@tanstack/react-router'
import { SimulatorApp } from '@/components/simulator/simulator-app'
import { pageTitle } from '@/lib/page-title'

export const Route = createFileRoute('/simulator')({
  head: () => ({
    meta: [{ title: pageTitle('Scheduler simulator') }],
  }),
  component: SimulatorApp,
})

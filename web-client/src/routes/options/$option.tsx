import { createFileRoute, notFound } from '@tanstack/react-router'
import { findOption } from '../../pages/options/catalog'
import { OptionPage } from '../../pages/options/OptionPage'

export const Route = createFileRoute('/options/$option')({
  beforeLoad: ({ params }) => {
    if (!findOption(params.option)) throw notFound()
  },
  component: OptionPage,
})

import { createFileRoute } from '@tanstack/react-router'
import { ApiTokensPage } from '@/components/admin/api-tokens-page'
import { pageTitle } from '@/lib/page-title'

export const Route = createFileRoute('/_app/admin/api-tokens')({
  head: () => ({
    meta: [{ title: pageTitle('API tokens · Admin') }],
  }),
  component: ApiTokensPage,
})

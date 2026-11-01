import { createFileRoute } from '@tanstack/react-router'
import { AccountAdmin } from '../../../../../pages/admin/AccountAdmin'

export const Route = createFileRoute('/_authenticated/_shell/admin/accounts/$accountId')({
  component: AccountAdmin,
})

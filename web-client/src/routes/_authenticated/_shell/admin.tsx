import { createFileRoute, redirect } from '@tanstack/react-router'
import { can, Permission } from '../../../api/permissions'
import { sessionQuery } from '../../../api/queries'
import { Admin } from '../../../pages/admin/Admin'

export const Route = createFileRoute('/_authenticated/_shell/admin')({
  // An account without `admin.view` goes to Home. The loader runs again
  // after each admin write, so a visitor who takes it from themselves goes
  // too.
  loader: async ({ context: { api, queryClient } }) => {
    const account = await queryClient.ensureQueryData(sessionQuery(api))
    if (!can(account, Permission.adminView)) throw redirect({ to: '/', replace: true })
  },
  component: Admin,
})

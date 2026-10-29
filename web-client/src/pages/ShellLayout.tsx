import { Outlet } from '@tanstack/react-router'
import { AppShell } from './AppShell'
import { SignInErrorAlert } from './SignInErrorAlert'

// The frame of most authenticated pages: AppShell around the page, and the
// message of a sign-in that came back with an error.
export function ShellLayout() {
  return (
    <AppShell>
      <SignInErrorAlert />
      <Outlet />
    </AppShell>
  )
}

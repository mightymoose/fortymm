import { Outlet } from '@tanstack/react-router'
import { AppUpdate } from './AppUpdate.tsx'

// Every screen, plus the toast that offers a new version of the app.
export function RootLayout() {
  return (
    <>
      <Outlet />
      <AppUpdate />
    </>
  )
}

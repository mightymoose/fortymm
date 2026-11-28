import type { IconName } from '../../design-system/Icon.tsx'

// The pages the sidebar links to, in order. The router marks a link current at its path and below
// it (the new match screen, under /matches), and the dashboard's, at /, only at / itself.
// /design-system and /health have no link: they are reached by their address. Admin, the staff's
// area, is in the sidebar only, not the phone's bottom bar.
export const sidebarLinks = [
  { to: '/', label: 'Dashboard', icon: 'layout-dashboard' },
  { to: '/matches', label: 'Matches', icon: 'list' },
  { to: '/users', label: 'Users', icon: 'users' },
  { to: '/admin', label: 'Admin', icon: 'shield' },
  { to: '/settings', label: 'Settings', icon: 'settings' },
] as const satisfies readonly { to: string; label: string; icon: IconName }[]

export type SidebarLinkTarget = (typeof sidebarLinks)[number]

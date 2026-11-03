// The admin page's tabs, in order, as its `tab` search param names them.
// The route file imports this, so it stays apart from the page's chunk.
export const adminTabs = ['roles', 'permissions', 'accounts', 'signing-keys'] as const
export type AdminTab = (typeof adminTabs)[number]

export function parseAdminTab(value: unknown): AdminTab | undefined {
  return adminTabs.find((tab) => tab === value)
}

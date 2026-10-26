// The designs of the account menu under the topbar's avatar, for review on
// one Preview. `?menu=<design>` on any authenticated page shows one. Without
// it, the topbar shows the first.
export const userMenuDesigns = ['menu', 'chip', 'card', 'sheet', 'confirm'] as const

export type UserMenuDesign = (typeof userMenuDesigns)[number]

export function parseUserMenuDesign(value: unknown): UserMenuDesign {
  return userMenuDesigns.includes(value as UserMenuDesign) ? (value as UserMenuDesign) : 'menu'
}

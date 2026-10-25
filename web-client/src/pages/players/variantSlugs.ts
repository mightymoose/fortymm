// The mockups of the players list, as their URL segments. This file stays
// small, because the route files import it.
export const variantSlugs = ['table', 'cards', 'rows', 'split', 'ladder'] as const

export type VariantSlug = (typeof variantSlugs)[number]

export function isVariantSlug(slug: string): slug is VariantSlug {
  return (variantSlugs as readonly string[]).includes(slug)
}

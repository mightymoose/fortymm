export const BRAND = 'FortyMM'

export function pageTitle(label?: string): string {
  return label ? `${label} · ${BRAND}` : BRAND
}

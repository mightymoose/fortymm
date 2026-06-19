import type { CardProps } from './card'

/** Props for `Card` — a padded surface wrapping some body content. */
export function buildCardProps(overrides: Partial<CardProps> = {}): CardProps {
  return { children: 'Card body', ...overrides }
}

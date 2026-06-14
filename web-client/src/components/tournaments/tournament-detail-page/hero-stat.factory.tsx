import { Trophy } from 'lucide-react'

import type { HeroStatProps } from './hero-stat'

/** Props for `HeroStat` — the "Events" stat by default. */
export function buildHeroStatProps(
  overrides: Partial<HeroStatProps> = {},
): HeroStatProps {
  return {
    label: 'Events',
    value: 5,
    icon: <Trophy size={16} />,
    ...overrides,
  }
}

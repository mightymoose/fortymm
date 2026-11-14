import { designSystemScreenshots } from '../pages/design-system.ts'

// How the design system page's Type tab looks, proven by pictures: each
// target of the reference sheet's Type board
// (references/design-system/Typography.dc.html), by the board's
// data-testid, against a baseline in __screenshots__/design-system-type.spec.ts/
// that was compared by eye with the board when it was made. The rows of the
// type styles and the size scale hold the value the theme gives each style
// and size, so a change to one fails here. One test per section: the
// section, then each target in it, each a soft assertion.
const { test, looksAsBefore } = designSystemScreenshots('type')

const sizes = [
  'text-3xl',
  'text-2xl',
  'text-xl',
  'text-lg',
  'text-md',
  'text-base',
  'text-sm',
  'text-xs',
]

const sections: Record<string, string[]> = {
  'section-families': ['family-ui', 'family-num', 'family-display'],
  'section-type-styles': [
    'h1',
    'h2',
    'h3',
    'body',
    'meta',
    'label',
    'score',
    'scoreboard-display',
  ].map((style) => `type-${style}`),
  'section-size-scale': [
    'type-scale',
    ...sizes.map((token) => `size-${token}`),
  ],
  'section-line-heights': ['lh-lh-tight', 'lh-lh-snug', 'lh-lh-normal'],
}

for (const [section, targets] of Object.entries(sections)) {
  test(`${section} and each of its targets look as their baselines`, async ({
    designSystem,
  }) => {
    await looksAsBefore(designSystem, section)
    for (const target of targets) {
      await looksAsBefore(designSystem, target)
    }
  })
}

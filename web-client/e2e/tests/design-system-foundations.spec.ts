import { designSystemScreenshots } from '../pages/design-system.ts'

// How the design system page's Foundations tab looks, proven by pictures:
// each target of the reference sheet's "Spacing, radii, shadows, icons"
// board (references/design-system/Foundations.dc.html), by the board's
// data-testid, against a baseline in
// __screenshots__/design-system-foundations.spec.ts/ that was compared by
// eye with the board when it was made. The spacing rows and radii hold the
// value the theme gives each token, so a change to one fails here. One test
// per section: the section, then each target in it, each a soft assertion.
const { test, looksAsBefore } = designSystemScreenshots('foundations')

const icons = [
  'check',
  'circle-check',
  'x',
  'plus',
  'triangle-alert',
  'circle-alert',
  'info',
  'clock',
  'calendar',
  'search',
  'chevron-down',
  'ellipsis',
  'undo',
  'check-sm',
  'clock-sm',
  'search-sm',
]

const sections: Record<string, string[]> = {
  'section-spacing': [
    'spacing-scale',
    ...['s-1', 's-2', 's-3', 's-4', 's-5', 's-6', 's-8', 's-12', 's-16'].map(
      (token) => `space-${token}`,
    ),
  ],
  'section-radii': ['r-sm', 'r-md', 'r-lg', 'r-pill'].map(
    (token) => `radius-${token}`,
  ),
  'section-shadows': ['shadow-overlay', 'shadow-tooltip', 'focus-ring'],
  'section-status-markers': [
    'live',
    'serve',
    'rating-up',
    'rating-down',
    'rest',
    'offline',
    'conflict',
    'danger',
  ].map((marker) => `marker-${marker}`),
  'section-icons': ['icon-set', ...icons.map((icon) => `icon-${icon}`)],
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

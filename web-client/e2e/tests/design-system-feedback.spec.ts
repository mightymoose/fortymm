import { designSystemScreenshots } from '../pages/design-system.ts'

// How the design system page's Feedback tab looks, proven by pictures: each
// target of the reference sheet's "Containers, feedback, overlays" board
// (references/design-system/Feedback.dc.html), by the board's data-testid,
// against a baseline in __screenshots__/design-system-feedback.spec.ts/
// that was compared by eye with the board when it was made. The overlays
// are drawn in place, open. One test per section: the section, then each
// target in it, each a soft assertion.
const { test, looksAsBefore } = designSystemScreenshots('feedback')

const sections: Record<string, string[]> = {
  'section-card': [
    'role-card',
    'role-notice-examples',
    'notice-default',
    'notice-rest',
    'notice-success',
    'notice-warning',
  ],
  'section-alerts': ['role-warning', 'role-error'],
  'section-overlays': ['role-toast', 'role-tooltip', 'ex-menu', 'ex-dialog'],
  'section-data': [
    'ex-tags',
    'ex-avatars',
    'ex-meters',
    'ex-data-table',
    'ex-accordion',
  ],
  'section-navigation': ['ex-navigation', 'ex-crumbs-pages', 'ex-empty'],
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

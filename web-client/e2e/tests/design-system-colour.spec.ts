import { designSystemScreenshots } from '../pages/design-system.ts'

// How the design system page's Colour tab looks, proven by pictures: each
// target of the reference sheet's Colour board
// (references/design-system/Main.dc.html), by the board's data-testid,
// against a baseline in __screenshots__/design-system-colour.spec.ts/ that
// was compared by eye with the board when it was made. A swatch's picture
// holds its colour and the value the theme gives it, so a token that
// changes fails here. One test per section: the section, then each target
// in it, each a soft assertion.
const { test, looksAsBefore } = designSystemScreenshots('colour')

const sections: Record<string, string[]> = {
  'section-ink': [
    'ink-950',
    'ink-900',
    'ink-800',
    'ink-700',
    'ink-600',
    'ink-500',
    'ink-400',
  ].map((token) => `color-${token}`),
  'section-chalk-ball': [
    'chalk-50',
    'chalk-100',
    'chalk-300',
    'chalk-500',
    'ball-200',
    'ball-400',
    'ball-500',
    'ball-600',
  ].map((token) => `color-${token}`),
  'section-status-hues': [
    'red-400',
    'green-400',
    'amber-300',
    'blue-300',
    'danger',
    'border-field',
  ].map((token) => `color-${token}`),
  'section-action': [
    'accent',
    'accent-hover',
    'accent-press',
    'accent-soft',
    'accent-text',
    'on-accent',
  ].map((token) => `color-${token}`),
  'section-status': [
    'live',
    'serving',
    'winner',
    'loser',
    'rating-up',
    'rating-down',
    'conflict',
    'conflict-soft',
    'rest',
    'rest-soft',
    'danger-soft',
    'success',
  ].map((token) => `color-${token}`),
  'section-text-surface-border': [
    'fg-1',
    'fg-2',
    'fg-3',
    'fg-placeholder',
    'fg-disabled',
    'bg-app',
    'bg-panel',
    'bg-group',
    'bg-hover',
    'border-subtle',
    'border-control',
    'border-field-hover',
  ].map((token) => `color-${token}`),
  'section-text-on-surfaces': [
    'text-on-bg-app',
    'text-on-bg-panel',
    'text-on-bg-group',
  ],
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

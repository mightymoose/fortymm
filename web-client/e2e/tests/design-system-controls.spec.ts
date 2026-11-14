import { designSystemScreenshots } from '../pages/design-system.ts'

// How the design system page's Controls tab looks, proven by pictures: each
// target of the reference sheet's Controls board
// (references/design-system/Controls.dc.html), found by the data-testid the
// board gives it, against a baseline in
// __screenshots__/design-system-controls.spec.ts/ that was compared by eye
// with the board when it was made. One test per section, matrix row or
// group of examples; inside one, each target is a soft assertion, so every
// target that changed is named.
//
// Baselines are made by the suite's own container (Linux, the pinned
// Chromium): ./bin/mise run web-client:e2e -- --update-snapshots, then look
// at each changed picture beside the board before committing it.
const { test, looksAsBefore } = designSystemScreenshots('controls')

// Each matrix row of the board, and its cells: state-<component>--<state>.
// A state a control doesn't have has no cell.
const rows: Record<string, string[]> = {
  'primary-button': ['default', 'hover', 'focus', 'pressed', 'disabled', 'loading'],
  'secondary-button': ['default', 'hover', 'focus', 'pressed', 'disabled', 'loading'],
  'ghost-button': ['default', 'hover', 'focus', 'pressed', 'disabled', 'loading'],
  'danger-button': ['default', 'hover', 'focus', 'pressed', 'disabled'],
  'danger-solid-button': ['default', 'hover', 'focus', 'pressed', 'disabled'],
  'link-button': ['default', 'hover', 'focus'],
  'text-field': ['default', 'hover', 'focus', 'disabled', 'error', 'error-focus'],
  select: ['default', 'hover', 'focus', 'disabled', 'error', 'error-focus'],
  checkbox: ['default', 'hover', 'focus', 'selected', 'mixed', 'disabled', 'disabled-on'],
  radio: ['default', 'hover', 'focus', 'selected', 'disabled'],
  switch: ['default', 'hover', 'focus', 'selected', 'disabled'],
  'filter-chip': ['default', 'hover', 'focus', 'selected', 'disabled'],
  'segmented-option': ['default', 'hover', 'focus', 'selected', 'disabled'],
  tab: ['default', 'hover', 'focus', 'selected', 'disabled'],
}

// The examples below the matrices.
const examples: Record<string, string[]> = {
  'button sizes': [
    'button-sizes',
    'button-size-sm',
    'button-size-md',
    'button-size-lg',
    'button-size-xl',
    'button-size-icon',
    'button-size-icon-sm',
    'button-with-icon',
  ],
  fields: ['field-anatomy', 'field-error', 'field-textarea'],
  'selection groups': ['group-tabs', 'group-segmented', 'group-chips'],
}

const sections = [
  'section-buttons',
  'section-button-sizes',
  'section-fields',
  'section-choices',
  'section-selection-groups',
]

for (const section of sections) {
  test(`${section} looks as its baseline`, async ({ designSystem }) => {
    await looksAsBefore(designSystem, section)
  })
}

for (const [component, states] of Object.entries(rows)) {
  test(`state-${component} and each of its states look as their baselines`, async ({
    designSystem,
  }) => {
    await looksAsBefore(designSystem, `state-${component}`)
    for (const state of states) {
      await looksAsBefore(designSystem, `state-${component}--${state}`)
    }
  })
}

for (const [name, testIds] of Object.entries(examples)) {
  test(`the ${name} examples look as their baselines`, async ({
    designSystem,
  }) => {
    for (const testId of testIds) {
      await looksAsBefore(designSystem, testId)
    }
  })
}

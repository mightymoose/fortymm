import { expect, test as base } from '../pages/test.ts'
import { DesignSystemPage } from '../pages/app.ts'

// How the design system page's controls look, proven by pictures: each
// target of the reference sheet's Controls board
// (references/design-system/Controls.dc.html), found by the data-testid the
// board gives it, against a baseline in __screenshots__/design-system.spec.ts/
// that was compared by eye with the board when it was made. One test per
// section, matrix row or group of examples; inside one, each target is a
// soft assertion, so every target that changed is named.
//
// Baselines are made by the suite's own container (Linux, the pinned
// Chromium): ./bin/mise run web-client:e2e -- --update-snapshots, then look
// at each changed picture beside the board before committing it.

// The board's width: its 1280px less its 48px margins, plus the app's own
// 16px margins on each side, plus the layout's sidebar, expanded as it
// starts (240px, Sidebar.css), so each section is laid out at the board's
// width and a target here is the size of the same target there.
base.use({ viewport: { width: 1216 + 240, height: 900 } })

// Each test starts on the page, drawn, fonts loaded. (Playwright's `use`
// is named `provide` here: lint takes a call to `use` for React's hook.)
const test = base.extend<{ designSystem: DesignSystemPage }>({
  designSystem: async ({ page }, provide) => {
    const designSystem = new DesignSystemPage(page)
    await designSystem.goto()
    await designSystem.waitUntilDrawn()
    await provide(designSystem)
  },
})

async function looksAsBefore(designSystem: DesignSystemPage, testId: string) {
  await expect
    .soft(designSystem.target(testId))
    .toHaveScreenshot(`${testId}.png`)
}

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

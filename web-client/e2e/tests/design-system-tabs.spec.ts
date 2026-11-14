import { designSystemScreenshots } from '../pages/design-system.ts'
import { expect } from '../pages/test.ts'

// How the design system page's tabs look, proven by pictures: the tab row
// (data-testid design-system-tabs), in the design system's tab look (the
// Controls board's group-tabs, references/design-system/Controls.dc.html),
// the current page's tab selected, against baselines in
// __screenshots__/design-system-tabs.spec.ts/ compared by eye with that
// board when they were made.
const { test, looksAsBefore } = designSystemScreenshots('type')

test('the tabs look as their baseline, the current page’s tab selected', async ({
  designSystem,
}) => {
  await looksAsBefore(designSystem, 'design-system-tabs')
})

test('a tab reached with the keyboard shows its focus ring', async ({
  designSystem,
  page,
}) => {
  // From the tab before it (the layout's top bar and sidebar come first in
  // the tab order), one Tab on: focus by keyboard, the current page's tab.
  await designSystem.tabs.getByRole('link', { name: 'Colour' }).focus()
  await page.keyboard.press('Tab')
  await expect(designSystem.tabs.getByRole('link', { name: 'Type' })).toBeFocused()

  await expect(designSystem.target('design-system-tabs')).toHaveScreenshot(
    'design-system-tabs--focus.png',
  )
})

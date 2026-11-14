import { DesignSystemPage, type DesignSystemTab } from './app.ts'
import { expect, test as base } from './test.ts'

// What every screenshot spec of the design system page shares
// (tests/design-system-*.spec.ts, one per tab). Call it once, at the top of
// the spec file: it sets the file's viewport and gives a `test` whose tests
// each start on `tab`'s page, drawn, fonts loaded.
//
// The viewport is the board's width: its 1280px less its 48px margins, plus
// the app's own 16px margins on each side, plus the layout's sidebar,
// expanded as it starts (240px, Sidebar.css), so each section is laid out at
// the board's width and a target here is the size of the same target there.
export function designSystemScreenshots(tab: DesignSystemTab) {
  base.use({ viewport: { width: 1216 + 240, height: 900 } })

  // (Playwright's `use` is named `provide` here: lint takes a call to `use`
  // for React's hook.)
  const test = base.extend<{ designSystem: DesignSystemPage }>({
    designSystem: async ({ page }, provide) => {
      const designSystem = new DesignSystemPage(page)
      await designSystem.goto(tab)
      await designSystem.waitUntilDrawn()
      await provide(designSystem)
    },
  })

  // Compares a target, by its data-testid, with its baseline,
  // __screenshots__/<spec file>/<data-testid>.png. A soft assertion, so a
  // test names every target that changed.
  async function looksAsBefore(designSystem: DesignSystemPage, testId: string) {
    await expect
      .soft(designSystem.target(testId))
      .toHaveScreenshot(`${testId}.png`)
  }

  return { test, looksAsBefore }
}

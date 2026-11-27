import { expect, test } from '@playwright/test'
import { targets } from './boards.ts'

for (const target of targets) {
  test.describe(`design system (${target.name})`, () => {
    test.describe('main board', () => {
      test('shows the showcase title', async ({ page }) => {
        const { main } = target.boards(page)
        await main.goto()
        await expect(main.heading).toBeVisible()
      })

      test('shows the Foundations section', async ({ page }) => {
        const { main } = target.boards(page)
        await main.goto()
        await expect(main.foundationsHeading).toBeVisible()
      })

      test('links to Foundations', async ({ page }) => {
        const { main } = target.boards(page)
        await main.goto()
        await main.foundationsLink.click()
        await expect(main.foundationsHeading).toBeVisible()
      })

      test('links to Roles and buttons', async ({ page }) => {
        const { main, roles } = target.boards(page)
        await main.goto()
        await main.rolesLink.click()
        await expect(roles.rolesAtAGlanceHeading).toBeVisible()
      })

      test('links to Fields and selection', async ({ page }) => {
        const { main, forms } = target.boards(page)
        await main.goto()
        await main.formsLink.click()
        await expect(forms.fieldsAndChoicesHeading).toBeVisible()
      })

      test('links to Containers and feedback', async ({ page }) => {
        const { main, containers } = target.boards(page)
        await main.goto()
        await main.containersLink.click()
        await expect(containers.containersHeading).toBeVisible()
      })

      test('links to Overlays', async ({ page }) => {
        const { main, overlays } = target.boards(page)
        await main.goto()
        await main.overlaysLink.click()
        await expect(overlays.overlaysHeading).toBeVisible()
      })

      test('links to Match components', async ({ page }) => {
        const { main, match } = target.boards(page)
        await main.goto()
        await main.matchLink.click()
        await expect(match.matchComponentsHeading).toBeVisible()
      })

      test('links to More components', async ({ page }) => {
        const { main, more } = target.boards(page)
        await main.goto()
        await main.moreLink.click()
        await expect(more.moreComponentsHeading).toBeVisible()
      })

      test('links to State matrix', async ({ page }) => {
        const { main, states } = target.boards(page)
        await main.goto()
        await main.statesLink.click()
        await expect(states.stateMatrixHeading).toBeVisible()
      })
    })

    test('roles board shows Roles at a glance', async ({ page }) => {
      const { roles } = target.boards(page)
      await roles.goto()
      await expect(roles.rolesAtAGlanceHeading).toBeVisible()
    })

    test('roles board shows Buttons', async ({ page }) => {
      const { roles } = target.boards(page)
      await roles.goto()
      await expect(roles.buttonsHeading).toBeVisible()
    })

    test('forms board shows Fields and choices', async ({ page }) => {
      const { forms } = target.boards(page)
      await forms.goto()
      await expect(forms.fieldsAndChoicesHeading).toBeVisible()
    })

    test('forms board shows Selection', async ({ page }) => {
      const { forms } = target.boards(page)
      await forms.goto()
      await expect(forms.selectionHeading).toBeVisible()
    })

    test('containers board shows Containers', async ({ page }) => {
      const { containers } = target.boards(page)
      await containers.goto()
      await expect(containers.containersHeading).toBeVisible()
    })

    test('containers board shows Feedback', async ({ page }) => {
      const { containers } = target.boards(page)
      await containers.goto()
      await expect(containers.feedbackHeading).toBeVisible()
    })

    test('overlays board shows Overlays', async ({ page }) => {
      const { overlays } = target.boards(page)
      await overlays.goto()
      await expect(overlays.overlaysHeading).toBeVisible()
    })

    test('match board shows Match components', async ({ page }) => {
      const { match } = target.boards(page)
      await match.goto()
      await expect(match.matchComponentsHeading).toBeVisible()
    })

    test('more board shows More components', async ({ page }) => {
      const { more } = target.boards(page)
      await more.goto()
      await expect(more.moreComponentsHeading).toBeVisible()
    })

    test('states board shows State matrix', async ({ page }) => {
      const { states } = target.boards(page)
      await states.goto()
      await expect(states.stateMatrixHeading).toBeVisible()
    })
  })
}

import type { Locator } from '@playwright/test'
import { expect, test } from './fixtures.ts'

test('shows the Design System title', async ({ designSystemPage }) => {
  await designSystemPage.goto()

  await expect(designSystemPage.title).toHaveText('Design System')
})

// Both tests below compare against the same screenshot, so the app's header
// has to render exactly like the reference kit's header with the app's copy
// swapped in. Update the screenshot with `npx playwright test
// --update-snapshots` only when the reference itself changes.
test.describe('header', () => {
  test('matches the screenshot', async ({ designSystemPage }) => {
    await designSystemPage.goto()

    await expect(designSystemPage.header).toHaveScreenshot('header.png')
  })

  test('matches the reference kit header', async ({
    designSystemPage,
    referenceKitPage,
  }) => {
    await designSystemPage.goto()
    const title = await designSystemPage.title.innerText()
    const subtitle = await designSystemPage.subtitle.innerText()

    await referenceKitPage.goto()
    await referenceKitPage.setHeaderText(title, subtitle)

    await expect(referenceKitPage.header).toHaveScreenshot('header.png')
  })
})

// The intro, the Forms & Input section and its component cards use the
// reference kit's own copy, so they're compared with the kit as is. The kit's
// section goes on to more cards than the app has yet, so the section's
// heading, lead and cards are compared one by one.
test.describe('intro', () => {
  test('matches the screenshot', async ({ designSystemPage }) => {
    await designSystemPage.goto()

    await expect(designSystemPage.intro).toHaveScreenshot('intro.png')
  })

  test('matches the reference kit intro', async ({ referenceKitPage }) => {
    await referenceKitPage.goto()

    await expect(referenceKitPage.intro).toHaveScreenshot('intro.png')
  })
})

test.describe('Forms & Input section', () => {
  test('matches the screenshot', async ({ designSystemPage }) => {
    await designSystemPage.goto()

    await expect(designSystemPage.formsSectionHeading).toHaveScreenshot(
      'forms-heading.png',
    )
    await expect(designSystemPage.formsSectionLead).toHaveScreenshot(
      'forms-lead.png',
    )
  })

  test('matches the reference kit section', async ({ referenceKitPage }) => {
    await referenceKitPage.goto()

    await expect(referenceKitPage.formsSectionHeading).toHaveScreenshot(
      'forms-heading.png',
    )
    await expect(referenceKitPage.formsSectionLead).toHaveScreenshot(
      'forms-lead.png',
    )
  })
})

// Nothing is hovered or focused first, so these show the buttons' resting
// styles.
test.describe('Button card', () => {
  test('matches the screenshot', async ({ designSystemPage }) => {
    await designSystemPage.goto()

    await expect(designSystemPage.buttonCard).toHaveScreenshot(
      'button-card.png',
    )
  })

  test('matches the reference kit card', async ({ referenceKitPage }) => {
    await referenceKitPage.goto()

    await expect(referenceKitPage.buttonCard).toHaveScreenshot(
      'button-card.png',
    )
  })
})

// Nothing is focused or typed into first, so these show the inputs' resting
// styles, with no focus ring or caret.
test.describe('Input · Label · Form Field card', () => {
  test('matches the screenshot', async ({ designSystemPage }) => {
    await designSystemPage.goto()

    await expect(designSystemPage.inputCard).toHaveScreenshot('input-card.png')
  })

  test('matches the reference kit card', async ({ referenceKitPage }) => {
    await referenceKitPage.goto()

    await expect(referenceKitPage.inputCard).toHaveScreenshot('input-card.png')
  })
})

// Nothing is focused or typed into first, so these show the textarea's
// resting style, with no focus ring or caret.
test.describe('Textarea card', () => {
  test('matches the screenshot', async ({ designSystemPage }) => {
    await designSystemPage.goto()

    await expect(designSystemPage.textareaCard).toHaveScreenshot(
      'textarea-card.png',
    )
  })

  test('matches the reference kit card', async ({ referenceKitPage }) => {
    await referenceKitPage.goto()

    await expect(referenceKitPage.textareaCard).toHaveScreenshot(
      'textarea-card.png',
    )
  })
})

// Focuses a text control and returns the area to screenshot: the control plus
// its 3px focus ring, which an element screenshot of it would cut off.
async function focusWithRing(control: Locator) {
  await control.focus()
  const box = (await control.boundingBox())!
  const ring = 4
  return {
    x: box.x - ring,
    y: box.y - ring,
    width: box.width + 2 * ring,
    height: box.height + 2 * ring,
  }
}

// Player tag shows the focus style; Email shows it on an invalid input, where
// the error border stays and the focus ring is added. The caret is hidden.
for (const [name, screenshot] of [
  ['Player tag', 'player-tag-focused.png'],
  ['Email', 'email-focused.png'],
] as const) {
  test.describe(`focused ${name} input`, () => {
    test('matches the screenshot', async ({ designSystemPage, page }) => {
      await designSystemPage.goto()
      const clip = await focusWithRing(designSystemPage.input(name))

      await expect(page).toHaveScreenshot(screenshot, { clip })
    })

    test('matches the reference kit input', async ({
      referenceKitPage,
      page,
    }) => {
      await referenceKitPage.goto()
      const clip = await focusWithRing(referenceKitPage.input(name))

      await expect(page).toHaveScreenshot(screenshot, { clip })
    })
  })
}

// The Match notes textarea shows the focus style. The caret is hidden.
test.describe('focused Match notes textarea', () => {
  test('matches the screenshot', async ({ designSystemPage, page }) => {
    await designSystemPage.goto()
    const clip = await focusWithRing(designSystemPage.textarea)

    await expect(page).toHaveScreenshot('match-notes-focused.png', { clip })
  })

  test('matches the reference kit textarea', async ({
    referenceKitPage,
    page,
  }) => {
    await referenceKitPage.goto()
    const clip = await focusWithRing(referenceKitPage.textarea)

    await expect(page).toHaveScreenshot('match-notes-focused.png', { clip })
  })
})

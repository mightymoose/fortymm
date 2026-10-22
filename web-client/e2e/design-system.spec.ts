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

// Nothing is focused or typed into first. The app's fourth cell is shown
// active by the demo's `activeIndex` until the input is focused, as the
// kit's is by its static `.on` cell.
test.describe('Input OTP card', () => {
  test('matches the screenshot', async ({ designSystemPage }) => {
    await designSystemPage.goto()

    await expect(designSystemPage.otpCard).toHaveScreenshot('otp-card.png')
  })

  test('matches the reference kit card', async ({ referenceKitPage }) => {
    await referenceKitPage.goto()

    await expect(referenceKitPage.otpCard).toHaveScreenshot('otp-card.png')
  })
})

// Nothing is hovered, focused or clicked first, so these show the boxes'
// resting styles, with no focus ring.
test.describe('Checkbox card', () => {
  test('matches the screenshot', async ({ designSystemPage }) => {
    await designSystemPage.goto()

    await expect(designSystemPage.checkboxCard).toHaveScreenshot(
      'checkbox-card.png',
    )
  })

  test('matches the reference kit card', async ({ referenceKitPage }) => {
    await referenceKitPage.goto()

    await expect(referenceKitPage.checkboxCard).toHaveScreenshot(
      'checkbox-card.png',
    )
  })
})

// The kit's checkboxes are static, with no focus style, so the tests below
// are the app's alone.
test.describe('Checkbox', () => {
  test('clicking a label toggles its box', async ({ designSystemPage }) => {
    await designSystemPage.goto()
    const agree = designSystemPage.checkbox('I agree to the rules of fair play')
    const invites = designSystemPage.checkbox('Email me match invites')
    await expect(agree).toBeChecked()
    await expect(invites).not.toBeChecked()

    await designSystemPage.clickCheckboxLabel('I agree to the rules of fair play')
    await designSystemPage.clickCheckboxLabel('Email me match invites')

    await expect(agree).not.toBeChecked()
    await expect(invites).toBeChecked()
  })

  test("the disabled one doesn't toggle", async ({ designSystemPage }) => {
    await designSystemPage.goto()
    const disabled = designSystemPage.checkbox('Disabled option')
    await expect(disabled).toBeDisabled()

    await designSystemPage.clickCheckboxLabel('Disabled option')

    await expect(disabled).not.toBeChecked()
  })

  // Tabbing to a box shows the text controls' focus ring on it, and Space
  // toggles it.
  test('keyboard focus shows the focus ring', async ({
    designSystemPage,
    page,
  }) => {
    await designSystemPage.goto()
    const invites = designSystemPage.checkbox('Email me match invites')
    const box = designSystemPage.checkboxBox('Email me match invites')
    await designSystemPage.checkbox('I agree to the rules of fair play').focus()

    await page.keyboard.press('Tab')

    await expect(invites).toBeFocused()
    await expect(box).toHaveCSS('border-color', 'rgb(255, 122, 26)')
    await expect(box).toHaveCSS(
      'box-shadow',
      'color(srgb 1 0.478431 0.101961 / 0.15) 0px 0px 0px 3px',
    )
    await page.keyboard.press('Space')
    await expect(invites).toBeChecked()
  })

  // A mouse click focuses the input too, but only keyboard focus shows the
  // ring.
  test('a click shows no focus ring', async ({ designSystemPage }) => {
    await designSystemPage.goto()
    const invites = designSystemPage.checkbox('Email me match invites')
    const box = designSystemPage.checkboxBox('Email me match invites')

    await designSystemPage.clickCheckboxLabel('Email me match invites')

    await expect(invites).toBeFocused()
    await expect(box).toHaveCSS('box-shadow', 'none')
  })
})

// Nothing is hovered, focused or clicked first, so these show the dots'
// resting styles, with no focus ring.
test.describe('Radio Group card', () => {
  test('matches the screenshot', async ({ designSystemPage }) => {
    await designSystemPage.goto()

    await expect(designSystemPage.radioCard).toHaveScreenshot(
      'radio-card.png',
    )
  })

  test('matches the reference kit card', async ({ referenceKitPage }) => {
    await referenceKitPage.goto()

    await expect(referenceKitPage.radioCard).toHaveScreenshot(
      'radio-card.png',
    )
  })
})

// The kit's radios are static, with no focus style, so the tests below are
// the app's alone.
test.describe('Radio Group', () => {
  test('clicking a label selects its option', async ({ designSystemPage }) => {
    await designSystemPage.goto()
    const best5 = designSystemPage.radio('Singles · best of 5')
    const doubles = designSystemPage.radio('Doubles · best of 5')
    await expect(best5).toBeChecked()
    await expect(doubles).not.toBeChecked()

    await designSystemPage.clickRadioLabel('Doubles · best of 5')

    await expect(doubles).toBeChecked()
    await expect(best5).not.toBeChecked()
  })

  // Tab goes to the selected option and shows the text controls' focus ring
  // on its dot; the group is one Tab stop.
  test('keyboard focus shows the focus ring', async ({
    designSystemPage,
    page,
  }) => {
    await designSystemPage.goto()
    const best5 = designSystemPage.radio('Singles · best of 5')
    const dot = designSystemPage.radioDot('Singles · best of 5')
    await designSystemPage.checkbox('Email me match invites').focus()

    await page.keyboard.press('Tab')

    await expect(best5).toBeFocused()
    await expect(dot).toHaveCSS('border-color', 'rgb(255, 122, 26)')
    await expect(dot).toHaveCSS(
      'box-shadow',
      'color(srgb 1 0.478431 0.101961 / 0.15) 0px 0px 0px 3px',
    )
    await expect(designSystemPage.radioDot('Singles · best of 7')).toHaveCSS(
      'box-shadow',
      'none',
    )

    // The next Tab leaves the group rather than going to its next option.
    await page.keyboard.press('Tab')
    await expect(designSystemPage.radioGroup.locator(':focus')).toHaveCount(0)
  })

  test('the arrow keys move the selection and the focus', async ({
    designSystemPage,
    page,
  }) => {
    await designSystemPage.goto()
    const best5 = designSystemPage.radio('Singles · best of 5')
    const best7 = designSystemPage.radio('Singles · best of 7')
    const doubles = designSystemPage.radio('Doubles · best of 5')
    await best5.focus()

    await page.keyboard.press('ArrowDown')
    await expect(best7).toBeChecked()
    await expect(best7).toBeFocused()
    await expect(best5).not.toBeChecked()
    await expect(designSystemPage.radioDot('Singles · best of 7')).toHaveCSS(
      'box-shadow',
      'color(srgb 1 0.478431 0.101961 / 0.15) 0px 0px 0px 3px',
    )

    await page.keyboard.press('ArrowDown')
    await expect(doubles).toBeChecked()
    await expect(doubles).toBeFocused()

    await page.keyboard.press('ArrowUp')
    await expect(best7).toBeChecked()
    await expect(best7).toBeFocused()
  })

  // A mouse click focuses the input too, but only keyboard focus shows the
  // ring.
  test('a click shows no focus ring', async ({ designSystemPage }) => {
    await designSystemPage.goto()
    const best7 = designSystemPage.radio('Singles · best of 7')

    await designSystemPage.clickRadioLabel('Singles · best of 7')

    await expect(best7).toBeFocused()
    await expect(designSystemPage.radioDot('Singles · best of 7')).toHaveCSS(
      'box-shadow',
      'none',
    )
  })
})

// The kit's cells are static, so this is the app's alone: focusing the input
// moves the active cell to the next empty one, where the next character goes.
test('focusing the Input OTP activates the next empty cell', async ({
  designSystemPage,
}) => {
  await designSystemPage.goto()
  await expect(designSystemPage.activeOtpCell).toHaveCount(1)
  await expect(designSystemPage.otpCell(3)).toHaveClass(/otp-cell--active/)

  await designSystemPage.otpInput.focus()

  await expect(designSystemPage.activeOtpCell).toHaveCount(1)
  await expect(designSystemPage.otpCell(4)).toHaveClass(/otp-cell--active/)

  await designSystemPage.otpInput.press('1')
  await expect(designSystemPage.otpInput).toHaveValue('40MM1')
  await expect(designSystemPage.otpCell(4)).toHaveText('1')
  await expect(designSystemPage.otpCell(5)).toHaveClass(/otp-cell--active/)
})

// The usual one-time code behaviour, in a real browser: a click goes to the
// cell under it, a filled cell's character is replaced, the arrow keys step
// between cells, Backspace clears, and a code arriving all at once (pasted or
// autofilled) fills the cells.
test('the Input OTP takes clicks, typing, arrows and Backspace', async ({
  designSystemPage,
  page,
}) => {
  await designSystemPage.goto()
  const input = designSystemPage.otpInput

  await designSystemPage.clickOtpCell(1)
  await expect(designSystemPage.otpCell(1)).toHaveClass(/otp-cell--active/)
  await page.keyboard.type('X')
  await expect(input).toHaveValue('4XMM')
  await expect(designSystemPage.otpCell(2)).toHaveClass(/otp-cell--active/)

  await page.keyboard.press('ArrowLeft')
  await expect(designSystemPage.otpCell(1)).toHaveClass(/otp-cell--active/)
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await expect(designSystemPage.otpCell(4)).toHaveClass(/otp-cell--active/)

  await page.keyboard.press('Backspace')
  await expect(input).toHaveValue('4XM')
  await expect(designSystemPage.otpCell(3)).toHaveText('')

  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.insertText('12-34-56-78')
  await expect(input).toHaveValue('123456')
  await expect(designSystemPage.otpCell(5)).toHaveText('6')
})

// On a phone the page is far narrower than the reference kit, which is only
// laid out for desktop. The cards' headers and demos still have to fit.
test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  // Each card's tag keeps clear of its title: beside it with room between,
  // or on a line of its own below it.
  test('card titles and tags stay apart', async ({ designSystemPage }) => {
    await designSystemPage.goto()

    for (const card of await designSystemPage.cards.all()) {
      const title = (await designSystemPage.cardTitle(card).boundingBox())!
      const tag = (await designSystemPage.cardTag(card).boundingBox())!
      const apart =
        tag.x >= title.x + title.width + 12 ||
        tag.y >= title.y + title.height
      expect(apart, (await card.getAttribute('aria-label')) ?? '').toBe(true)
    }
  })

  test('the Input OTP fits in its card', async ({ designSystemPage }) => {
    await designSystemPage.goto()
    const card = (await designSystemPage.otpCard.boundingBox())!
    const lastCell = (await designSystemPage.otpCell(5).boundingBox())!

    // The card's 32px padding stays clear on the right.
    expect(lastCell.x + lastCell.width).toBeLessThanOrEqual(
      card.x + card.width - 32,
    )
  })

  // Two columns would leave each input too narrow for its placeholder, so
  // the fields stack, each as wide as the card's content.
  test("the input card's fields stack", async ({ designSystemPage }) => {
    await designSystemPage.goto()
    const card = (await designSystemPage.inputCard.boundingBox())!
    const fields = await designSystemPage.inputCardFields.all()
    expect(fields).toHaveLength(4)

    let previousBottom = -Infinity
    for (const field of fields) {
      const box = (await field.boundingBox())!
      // Inside the card's 1px border and 32px padding on each side.
      expect(box.x).toBeCloseTo(card.x + 33, 0)
      expect(box.width).toBeCloseTo(card.width - 66, 0)
      expect(box.y).toBeGreaterThanOrEqual(previousBottom)
      previousBottom = box.y + box.height
    }
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

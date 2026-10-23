import type { Locator } from '@playwright/test'
import { expect, test } from './fixtures.ts'

test('shows the Design System title', async ({ designSystemPage }) => {
  await designSystemPage.goto()

  await expect(designSystemPage.title).toHaveText('Design System')
})

test('shows no loading screen and checks no health', async ({
  designSystemPage,
  page,
}) => {
  const healthRequests: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('/api/v1/health')) {
      healthRequests.push(request.url())
    }
  })

  await designSystemPage.goto()
  await expect(designSystemPage.title).toBeVisible()
  await page.waitForLoadState('networkidle')

  await expect(designSystemPage.loadingScreen).toHaveCount(0)
  expect(healthRequests).toEqual([])
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

// The intro, the Forms & Input, Data Display and Navigation sections and
// their component cards use the reference kit's own copy, so they're compared
// with the kit as is. The kit's sections go on to more cards than the app has
// yet, so each section's heading, lead and cards are compared one by one.
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

// Nothing is hovered, focused or clicked first, so these show the tracks'
// resting styles, with no focus ring.
test.describe('Switch card', () => {
  test('matches the screenshot', async ({ designSystemPage }) => {
    await designSystemPage.goto()

    await expect(designSystemPage.switchCard).toHaveScreenshot(
      'switch-card.png',
    )
  })

  test('matches the reference kit card', async ({ referenceKitPage }) => {
    await referenceKitPage.goto()

    await expect(referenceKitPage.switchCard).toHaveScreenshot(
      'switch-card.png',
    )
  })
})

// The thumb's computed transform: off at the left, on moved right by 18px.
// It transitions, so read it with expect.poll for its end state.
function thumbTransform(track: Locator) {
  return () =>
    track.evaluate(
      (element) =>
        element.ownerDocument.defaultView!.getComputedStyle(element, '::after')
          .transform,
    )
}

const thumbOn = 'matrix(1, 0, 0, 1, 18, 0)'

// The kit's switches are static, with no focus style, so the tests below are
// the app's alone.
test.describe('Switch', () => {
  test('clicking a label toggles it and moves its thumb', async ({
    designSystemPage,
  }) => {
    await designSystemPage.goto()
    const profile = designSystemPage.switch('Public profile')
    const nearby = designSystemPage.switch('Notify me of nearby matches')
    await expect(profile).toBeChecked()
    await expect(nearby).not.toBeChecked()

    await designSystemPage.clickSwitchLabel('Public profile')
    await designSystemPage.clickSwitchLabel('Notify me of nearby matches')

    await expect(profile).not.toBeChecked()
    await expect(nearby).toBeChecked()
    await expect
      .poll(thumbTransform(designSystemPage.switchTrack('Public profile')))
      .toBe('none')
    await expect
      .poll(
        thumbTransform(
          designSystemPage.switchTrack('Notify me of nearby matches'),
        ),
      )
      .toBe(thumbOn)
  })

  // Tabbing to a switch shows the text controls' focus ring on its track,
  // and Space toggles it.
  test('keyboard focus shows the focus ring', async ({
    designSystemPage,
    page,
  }) => {
    await designSystemPage.goto()
    const nearby = designSystemPage.switch('Notify me of nearby matches')
    const track = designSystemPage.switchTrack('Notify me of nearby matches')
    await designSystemPage.switch('Public profile').focus()

    await page.keyboard.press('Tab')

    await expect(nearby).toBeFocused()
    await expect(track).toHaveCSS(
      'box-shadow',
      'color(srgb 1 0.478431 0.101961 / 0.15) 0px 0px 0px 3px',
    )
    await expect(
      designSystemPage.switchTrack('Public profile'),
    ).toHaveCSS('box-shadow', 'none')
    await page.keyboard.press('Space')
    await expect(nearby).toBeChecked()
    await expect.poll(thumbTransform(track)).toBe(thumbOn)
  })

  // A mouse click focuses the input too, but only keyboard focus shows the
  // ring.
  test('a click shows no focus ring', async ({ designSystemPage }) => {
    await designSystemPage.goto()
    const nearby = designSystemPage.switch('Notify me of nearby matches')

    await designSystemPage.clickSwitchLabel('Notify me of nearby matches')

    await expect(nearby).toBeFocused()
    await expect(
      designSystemPage.switchTrack('Notify me of nearby matches'),
    ).toHaveCSS('box-shadow', 'none')
  })

  // The demo has no disabled switch, so this test disables one in place.
  test("a disabled one fades and doesn't toggle", async ({
    designSystemPage,
  }) => {
    await designSystemPage.goto()
    const profile = designSystemPage.switch('Public profile')
    await profile.evaluate((input) => input.setAttribute('disabled', ''))

    await designSystemPage.clickSwitchLabel('Public profile')

    await expect(profile).toBeChecked()
    await expect(designSystemPage.switchLabel('Public profile')).toHaveCSS(
      'opacity',
      '0.5',
    )
  })

  test.describe('with reduced motion', () => {
    test.use({ reducedMotion: 'reduce' })

    test('the thumb moves without a transition', async ({
      designSystemPage,
    }) => {
      await designSystemPage.goto()
      const track = designSystemPage.switchTrack('Notify me of nearby matches')

      await designSystemPage.clickSwitchLabel('Notify me of nearby matches')

      expect(await thumbTransform(track)()).toBe(thumbOn)
      await expect(track).toHaveCSS('transition-duration', '0s')
    })
  })
})

// Nothing is hovered, focused or dragged first, so these show the thumbs'
// resting styles, with no focus ring.
test.describe('Slider card', () => {
  test('matches the screenshot', async ({ designSystemPage }) => {
    await designSystemPage.goto()

    await expect(designSystemPage.sliderCard).toHaveScreenshot(
      'slider-card.png',
    )
  })

  test('matches the reference kit card', async ({ referenceKitPage }) => {
    await referenceKitPage.goto()

    await expect(referenceKitPage.sliderCard).toHaveScreenshot(
      'slider-card.png',
    )
  })
})

// The kit's sliders are static, with no focus style, so the tests below are
// the app's alone.
test.describe('Slider', () => {
  const ring = 'color(srgb 1 0.478431 0.101961 / 0.15) 0px 0px 0px 3px'
  const resting = 'rgb(255, 122, 26) 0px 0px 0px 1px'

  test('dragging a thumb sets the value under the pointer', async ({
    designSystemPage,
  }) => {
    await designSystemPage.goto()

    await designSystemPage.dragSlider('Skill level', 0.75)

    await expect(designSystemPage.slider('Skill level')).toHaveValue('1820')
    await expect(designSystemPage.sliderValue('Skill level')).toHaveText(
      '1820',
    )
  })

  test('dragging a range thumb moves only that end', async ({
    designSystemPage,
  }) => {
    await designSystemPage.goto()

    await designSystemPage.dragSlider('Rating range maximum', 0.9)
    await designSystemPage.dragSlider('Rating range minimum', 0.1)

    await expect(designSystemPage.sliderValue('Rating range')).toHaveText(
      '1200 – 2000',
    )
  })

  test('the arrow keys, Home and End move a thumb by its step', async ({
    designSystemPage,
    page,
  }) => {
    await designSystemPage.goto()
    const skill = designSystemPage.slider('Skill level')
    const readout = designSystemPage.sliderValue('Skill level')
    await skill.focus()

    await page.keyboard.press('ArrowRight')
    await expect(readout).toHaveText('1630')
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowLeft')
    await expect(readout).toHaveText('1610')
    await page.keyboard.press('End')
    await expect(readout).toHaveText('2070')
    await page.keyboard.press('Home')
    await expect(readout).toHaveText('1070')
    await expect(skill).toHaveValue('1070')
  })

  // Tabbing to a thumb shows the text controls' focus ring on it alone.
  test('keyboard focus shows the focus ring', async ({
    designSystemPage,
    page,
  }) => {
    await designSystemPage.goto()
    const low = designSystemPage.sliderThumb('Rating range minimum')
    const high = designSystemPage.sliderThumb('Rating range maximum')
    await designSystemPage.slider('Skill level').focus()

    await page.keyboard.press('Tab')

    await expect(designSystemPage.slider('Rating range minimum')).toBeFocused()
    await expect(low).toHaveCSS('box-shadow', ring)
    await expect(low).toHaveCSS('border-color', 'rgb(255, 122, 26)')
    await expect(high).toHaveCSS('box-shadow', resting)
    await expect(
      designSystemPage.sliderThumb('Skill level'),
    ).toHaveCSS('box-shadow', resting)
  })

  // A mouse press focuses the input too, but only keyboard focus shows the
  // ring.
  test('a click shows no focus ring', async ({ designSystemPage, page }) => {
    await designSystemPage.goto()
    const thumb = designSystemPage.sliderThumb('Skill level')
    await thumb.scrollIntoViewIfNeeded()
    const box = (await thumb.boundingBox())!

    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)

    await expect(designSystemPage.slider('Skill level')).toBeFocused()
    await expect(designSystemPage.slider('Skill level')).toHaveValue('1620')
    await expect(thumb).toHaveCSS('box-shadow', resting)
  })

  // The demo has no disabled slider, so this test disables one in place.
  test("a disabled one fades and doesn't move", async ({
    designSystemPage,
    page,
  }) => {
    await designSystemPage.goto()
    const skill = designSystemPage.slider('Skill level')
    await skill.evaluate((input) => input.setAttribute('disabled', ''))

    await designSystemPage.dragSlider('Skill level', 0.75)
    await skill.focus()
    await page.keyboard.press('ArrowRight')

    await expect(skill).toHaveValue('1620')
    await expect(designSystemPage.sliderValue('Skill level')).toHaveText(
      '1620',
    )
    await expect(designSystemPage.sliderField('Skill level')).toHaveCSS(
      'opacity',
      '0.5',
    )
  })

  test("a range's thumbs don't cross", async ({ designSystemPage }) => {
    await designSystemPage.goto()

    await designSystemPage.dragSlider('Rating range minimum', 0.9)

    await expect(designSystemPage.sliderValue('Rating range')).toHaveText(
      '1800 – 1800',
    )
    const low = (await designSystemPage
      .sliderThumb('Rating range minimum')
      .boundingBox())!
    const high = (await designSystemPage
      .sliderThumb('Rating range maximum')
      .boundingBox())!
    expect(low.x).toBeCloseTo(high.x, 0)
  })

  // Thumbs that meet take one spot, so a drag there has to pick the thumb
  // that can move away from the end.
  test('thumbs that meet at an end can be dragged apart', async ({
    designSystemPage,
    page,
  }) => {
    await designSystemPage.goto()
    const readout = designSystemPage.sliderValue('Rating range')

    await designSystemPage.slider('Rating range minimum').focus()
    await page.keyboard.press('Home')
    await designSystemPage.slider('Rating range maximum').focus()
    await page.keyboard.press('Home')
    await expect(readout).toHaveText('1100 – 1100')
    await designSystemPage.dragSlider('Rating range maximum', 0.5)
    await expect(readout).toHaveText('1100 – 1600')

    await page.keyboard.press('End')
    await designSystemPage.slider('Rating range minimum').focus()
    await page.keyboard.press('End')
    await expect(readout).toHaveText('2100 – 2100')
    await designSystemPage.dragSlider('Rating range minimum', 0.5)
    await expect(readout).toHaveText('1600 – 2100')
  })

  test.describe('with reduced motion', () => {
    test.use({ reducedMotion: 'reduce' })

    test('the focus ring shows without a transition', async ({
      designSystemPage,
    }) => {
      await designSystemPage.goto()

      await expect(
        designSystemPage.sliderThumb('Skill level'),
      ).toHaveCSS('transition-duration', '0s')
    })
  })
})

// Nothing is hovered, focused or opened first, so these show the selects'
// resting styles, with no focus ring.
test.describe('Select card', () => {
  // The chevron's 45° hard edges sit half a pixel off the grid, so Chromium
  // rounds a few edge pixels differently on the app's page than on the kit's,
  // with the same styles and rects: 4 to 12 of them, depending on where the
  // card sits. The smallest real change, the chevron moved 1px, is 19.
  test('matches the screenshot', async ({ designSystemPage }) => {
    await designSystemPage.goto()

    await expect(designSystemPage.selectCard).toHaveScreenshot(
      'select-card.png',
      { maxDiffPixels: 15 },
    )
  })

  test('matches the reference kit card', async ({ referenceKitPage }) => {
    await referenceKitPage.goto()

    await expect(referenceKitPage.selectCard).toHaveScreenshot(
      'select-card.png',
    )
  })
})

// The kit's selects are static, with no focus style, so the tests below are
// the app's alone.
test.describe('Select', () => {
  const ring = 'color(srgb 1 0.478431 0.101961 / 0.15) 0px 0px 0px 3px'

  test('choosing an option sets its value', async ({ designSystemPage }) => {
    await designSystemPage.goto()
    const type = designSystemPage.select('Match type')

    await type.selectOption('Doubles')

    await expect(type).toHaveValue('Doubles')
  })

  test('the arrow keys change the value', async ({
    designSystemPage,
    page,
  }) => {
    await designSystemPage.goto()
    const type = designSystemPage.select('Match type')
    await type.focus()

    await page.keyboard.press('ArrowDown')
    await expect(type).toHaveValue('Doubles')
    await page.keyboard.press('ArrowUp')
    await expect(type).toHaveValue('Singles')
  })

  // Tabbing to a select shows the text controls' focus ring on it alone.
  test('keyboard focus shows the focus ring', async ({
    designSystemPage,
    page,
  }) => {
    await designSystemPage.goto()
    const length = designSystemPage.select('Match length')
    await designSystemPage.select('Match type').focus()

    await page.keyboard.press('Tab')

    await expect(length).toBeFocused()
    await expect(length).toHaveCSS('box-shadow', ring)
    await expect(length).toHaveCSS('border-color', 'rgb(255, 122, 26)')
    await expect(designSystemPage.select('Match type')).toHaveCSS(
      'box-shadow',
      'none',
    )
  })

  // Chromium matches :focus-visible on a click for a select as it does for
  // a text input, so the select keeps .input's :focus rule and a click
  // shows the ring too.
  test('a click shows the focus ring, as on a text input', async ({
    designSystemPage,
    page,
  }) => {
    await designSystemPage.goto()
    const type = designSystemPage.select('Match type')
    await type.scrollIntoViewIfNeeded()
    const box = (await type.boundingBox())!

    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    // Closes the picker the click opened.
    await page.keyboard.press('Escape')

    await expect(type).toBeFocused()
    await expect(type).toHaveCSS('box-shadow', ring)
  })

  // The demo has no disabled select, so this test disables one in place.
  test("a disabled one fades and doesn't open", async ({
    designSystemPage,
    page,
  }) => {
    await designSystemPage.goto()
    const type = designSystemPage.select('Match type')
    await type.evaluate((select) => select.setAttribute('disabled', ''))
    await type.scrollIntoViewIfNeeded()
    const box = (await type.boundingBox())!

    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await page.keyboard.press('ArrowDown')

    await expect(type).toHaveValue('Singles')
    await expect(type).not.toBeFocused()
    await expect(type).toHaveCSS('opacity', '0.5')
  })

  // The demo has no invalid select, so this test marks one in place.
  test('an invalid one shows the error border', async ({
    designSystemPage,
  }) => {
    await designSystemPage.goto()
    const type = designSystemPage.select('Match type')

    await type.evaluate((select) =>
      select.setAttribute('aria-invalid', 'true'),
    )

    // --loss, #FF4D6D.
    await expect(type).toHaveCSS('border-color', 'rgb(255, 77, 109)')
  })

  // The border fades to the focus color, as on a text input.
  test('the border color transitions', async ({ designSystemPage }) => {
    await designSystemPage.goto()

    await expect(designSystemPage.select('Match type')).toHaveCSS(
      'transition-duration',
      '0.12s',
    )
  })

  test.describe('with reduced motion', () => {
    test.use({ reducedMotion: 'reduce' })

    test('the border color changes without a transition', async ({
      designSystemPage,
    }) => {
      await designSystemPage.goto()

      await expect(designSystemPage.select('Match type')).toHaveCSS(
        'transition-duration',
        '0s',
      )
    })
  })
})

// The card opens on the reference's query, with its first match active, but
// nothing is hovered or focused, so there's no focus ring.
test.describe('Combobox card', () => {
  test('matches the screenshot', async ({ designSystemPage }) => {
    await designSystemPage.goto()

    await expect(designSystemPage.comboboxCard).toHaveScreenshot(
      'combobox-card.png',
    )
  })

  test('matches the reference kit card', async ({ referenceKitPage }) => {
    await referenceKitPage.goto()

    await expect(referenceKitPage.comboboxCard).toHaveScreenshot(
      'combobox-card.png',
    )
  })
})

// The kit's combobox is static, with no focus style, so the tests below are
// the app's alone.
test.describe('Combobox', () => {
  const ring = 'color(srgb 1 0.478431 0.101961 / 0.15) 0px 0px 0px 3px'

  test('typing filters the options', async ({ designSystemPage }) => {
    await designSystemPage.goto()
    const combobox = designSystemPage.combobox

    await combobox.clear()
    await combobox.pressSequentially('an')

    await expect(designSystemPage.comboboxOptions).toHaveText([
      'Silva, Ana 1710',
      'Tanaka, Kenji 1540',
    ])
    await expect(combobox).toHaveAttribute('aria-expanded', 'true')
  })

  test('the arrow keys move the active option, and Enter chooses it', async ({
    designSystemPage,
    page,
  }) => {
    await designSystemPage.goto()
    const combobox = designSystemPage.combobox
    const options = designSystemPage.comboboxOptions
    await combobox.focus()

    await page.keyboard.press('ArrowDown')
    const mai = options.nth(1)
    await expect(combobox).toHaveAttribute(
      'aria-activedescendant',
      (await mai.getAttribute('id'))!,
    )
    await expect(mai).toHaveAttribute('aria-selected', 'true')
    await expect(options.nth(0)).toHaveAttribute('aria-selected', 'false')

    // Up from the first option wraps to the last.
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('ArrowUp')
    const phuc = options.nth(2)
    await expect(combobox).toHaveAttribute(
      'aria-activedescendant',
      (await phuc.getAttribute('id'))!,
    )
    await expect(phuc).toHaveAttribute('aria-selected', 'true')

    await page.keyboard.press('Enter')
    await expect(combobox).toHaveValue('Nguyen, Phuc')
    await expect(combobox).toHaveAttribute('aria-expanded', 'false')
    await expect(options).toHaveCount(0)
  })

  // The input is borderless, so the ring goes on the box around it.
  test('keyboard focus shows the focus ring on the box', async ({
    designSystemPage,
    page,
  }) => {
    await designSystemPage.goto()
    await designSystemPage.select('Match length').focus()

    await page.keyboard.press('Tab')

    await expect(designSystemPage.combobox).toBeFocused()
    await expect(designSystemPage.comboboxBox).toHaveCSS('box-shadow', ring)
    await expect(designSystemPage.comboboxBox).toHaveCSS(
      'border-color',
      'rgb(255, 122, 26)',
    )
    await expect(designSystemPage.combobox).toHaveCSS('outline-style', 'none')
  })

  // The screenshot can't see the highlight: --bg-hover is white at 4%,
  // under the screenshot's color threshold.
  test('the active option is highlighted, and follows the pointer', async ({
    designSystemPage,
  }) => {
    await designSystemPage.goto()
    const options = designSystemPage.comboboxOptions
    const highlight = 'rgba(255, 255, 255, 0.04)'
    const none = 'rgba(0, 0, 0, 0)'
    await expect(options.nth(0)).toHaveCSS('background-color', highlight)
    await expect(options.nth(1)).toHaveCSS('background-color', none)

    await options.nth(2).hover()

    await expect(designSystemPage.combobox).toHaveAttribute(
      'aria-activedescendant',
      (await options.nth(2).getAttribute('id'))!,
    )
    await expect(options.nth(2)).toHaveCSS('background-color', highlight)
    await expect(options.nth(0)).toHaveCSS('background-color', none)
  })

  // The closed box is just its input row, inside the box's own border.
  test('Escape closes the list', async ({ designSystemPage, page }) => {
    await designSystemPage.goto()
    await designSystemPage.combobox.focus()

    await page.keyboard.press('Escape')

    await expect(designSystemPage.combobox).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    await expect(designSystemPage.combobox).toHaveValue('ngu')
    await expect(designSystemPage.comboboxOptions).toHaveCount(0)
    await expect(designSystemPage.comboboxInputRow).toHaveCSS(
      'border-bottom-width',
      '0px',
    )
  })

  test('a click shows the focus ring, as on a text input', async ({
    designSystemPage,
  }) => {
    await designSystemPage.goto()

    await designSystemPage.combobox.click()

    await expect(designSystemPage.combobox).toBeFocused()
    await expect(designSystemPage.comboboxBox).toHaveCSS('box-shadow', ring)
  })

  // The demo's combobox isn't disabled, so this test disables it in place.
  test("a disabled one fades and doesn't take typing", async ({
    designSystemPage,
    page,
  }) => {
    await designSystemPage.goto()
    const combobox = designSystemPage.combobox
    await combobox.evaluate((input) => input.setAttribute('disabled', ''))
    await combobox.scrollIntoViewIfNeeded()
    const box = (await combobox.boundingBox())!

    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await page.keyboard.type('x')

    await expect(combobox).toHaveValue('ngu')
    await expect(combobox).not.toBeFocused()
    await expect(designSystemPage.comboboxBox).toHaveCSS('opacity', '0.5')
  })

  // The demo's combobox isn't invalid, so these tests mark it in place.
  test('an invalid one shows the error border', async ({
    designSystemPage,
  }) => {
    await designSystemPage.goto()

    await designSystemPage.combobox.evaluate((input) =>
      input.setAttribute('aria-invalid', 'true'),
    )

    // --loss, #FF4D6D.
    await expect(designSystemPage.comboboxBox).toHaveCSS(
      'border-color',
      'rgb(255, 77, 109)',
    )
  })

  // The error border outranks the focus border, as on a text input. The
  // border fades between them, so it starts on the focus color: a check
  // made as the focus border faded in would still see the error color.
  test('the error border outranks the focus border', async ({
    designSystemPage,
  }) => {
    await designSystemPage.goto()
    const combobox = designSystemPage.combobox
    await combobox.focus()
    await expect(designSystemPage.comboboxBox).toHaveCSS(
      'border-color',
      'rgb(255, 122, 26)',
    )

    await combobox.evaluate((input) =>
      input.setAttribute('aria-invalid', 'true'),
    )

    await expect(designSystemPage.comboboxBox).toHaveCSS('box-shadow', ring)
    await expect(designSystemPage.comboboxBox).toHaveCSS(
      'border-color',
      'rgb(255, 77, 109)',
    )
  })

  // The border fades to the focus color, as on a text input.
  test('the border color transitions', async ({ designSystemPage }) => {
    await designSystemPage.goto()

    await expect(designSystemPage.comboboxBox).toHaveCSS(
      'transition-duration',
      '0.12s',
    )
  })

  test.describe('with reduced motion', () => {
    test.use({ reducedMotion: 'reduce' })

    test('the border color changes without a transition', async ({
      designSystemPage,
    }) => {
      await designSystemPage.goto()

      await expect(designSystemPage.comboboxBox).toHaveCSS(
        'transition-duration',
        '0s',
      )
    })
  })
})

// The card's today is the 14th, as the reference draws it, so the app's
// tests fix the page's clock there. The reference has no clock to fix.
const april14 = new Date(2026, 3, 14, 12)

// The card opens on the reference's April 2026, with the 12th chosen, but
// nothing is hovered or focused, so there's no focus ring.
test.describe('Date Picker card', () => {
  test('matches the screenshot', async ({ designSystemPage, page }) => {
    await page.clock.setFixedTime(april14)
    await designSystemPage.goto()

    await expect(designSystemPage.datePickerCard).toHaveScreenshot(
      'date-picker-card.png',
    )
  })

  test('matches the reference kit card', async ({ referenceKitPage }) => {
    await referenceKitPage.goto()

    await expect(referenceKitPage.datePickerCard).toHaveScreenshot(
      'date-picker-card.png',
    )
  })
})

// The kit's calendar is static, with no focus or hover style, so the tests
// below are the app's alone.
test.describe('Date Picker', () => {
  const ring = 'color(srgb 1 0.478431 0.101961 / 0.15) 0px 0px 0px 3px'
  const orange = 'rgb(255, 122, 26)'
  const none = 'rgba(0, 0, 0, 0)'

  test.beforeEach(async ({ designSystemPage, page }) => {
    await page.clock.setFixedTime(april14)
    await designSystemPage.goto()
  })

  test('the button closes and opens the calendar', async ({
    designSystemPage,
  }) => {
    const trigger = designSystemPage.datePickerTrigger
    await expect(trigger).toHaveAttribute('aria-expanded', 'true')

    await trigger.click()
    await expect(designSystemPage.datePickerDialog).toHaveCount(0)
    await expect(trigger).toHaveAttribute('aria-expanded', 'false')

    await trigger.click()
    await expect(designSystemPage.datePickerDialog).toBeVisible()
    await expect(designSystemPage.datePickerDay('April 12, 2026')).toBeFocused()
  })

  test('the arrow and Page keys move the focused day and change the month', async ({
    designSystemPage,
    page,
  }) => {
    const grid = designSystemPage.datePickerGrid
    await designSystemPage.datePickerDay('April 12, 2026').focus()

    await page.keyboard.press('ArrowRight')
    await expect(designSystemPage.datePickerDay('April 13, 2026')).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(designSystemPage.datePickerDay('April 20, 2026')).toBeFocused()
    await page.keyboard.press('End')
    await expect(designSystemPage.datePickerDay('April 25, 2026')).toBeFocused()

    await page.keyboard.press('PageDown')
    await expect(grid).toHaveAccessibleName('May 2026')
    await expect(designSystemPage.datePickerDay('May 25, 2026')).toBeFocused()

    await page.keyboard.press('PageUp')
    await page.keyboard.press('PageUp')
    await expect(grid).toHaveAccessibleName('March 2026')
    await expect(designSystemPage.datePickerDay('March 25, 2026')).toBeFocused()

    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('ArrowUp')
    await expect(grid).toHaveAccessibleName('February 2026')
    await expect(
      designSystemPage.datePickerDay('February 25, 2026'),
    ).toBeFocused()
  })

  test("Enter chooses a day and updates the button's text", async ({
    designSystemPage,
    page,
  }) => {
    await designSystemPage.datePickerDay('April 12, 2026').focus()

    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('Enter')

    const trigger = designSystemPage.datePickerTrigger
    await expect(designSystemPage.datePickerDialog).toHaveCount(0)
    await expect(trigger).toHaveText('April 11, 2026')
    await expect(trigger).toHaveAccessibleName('Match date April 11, 2026')
    await expect(trigger).toBeFocused()
  })

  test('Escape closes the calendar and gives the focus back to the button', async ({
    designSystemPage,
    page,
  }) => {
    await designSystemPage.nextMonth.focus()

    await page.keyboard.press('Escape')

    await expect(designSystemPage.datePickerDialog).toHaveCount(0)
    await expect(designSystemPage.datePickerTrigger).toBeFocused()
  })

  test('the month buttons change the month', async ({ designSystemPage }) => {
    await designSystemPage.nextMonth.click()
    await expect(designSystemPage.datePickerGrid).toHaveAccessibleName(
      'May 2026',
    )

    await designSystemPage.previousMonth.click()
    await designSystemPage.previousMonth.click()
    await expect(designSystemPage.datePickerGrid).toHaveAccessibleName(
      'March 2026',
    )
    await expect(designSystemPage.previousMonth).toBeFocused()
  })

  // The button is a .button, so it takes their outline, on keyboard focus
  // only. The day takes the text controls' ring.
  test('keyboard focus shows the focus rings', async ({
    designSystemPage,
    page,
  }) => {
    const trigger = designSystemPage.datePickerTrigger
    await designSystemPage.combobox.focus()

    await page.keyboard.press('Tab')
    await expect(trigger).toBeFocused()
    await expect(trigger).toHaveCSS('outline', `${orange} solid 2px`)

    // The card starts open, so Enter closes the calendar, then opens it
    // with the focus on the chosen day.
    await page.keyboard.press('Enter')
    await expect(designSystemPage.datePickerDialog).toHaveCount(0)
    await page.keyboard.press('Enter')
    const chosen = designSystemPage.datePickerDay('April 12, 2026')
    await expect(chosen).toBeFocused()
    await expect(chosen).toHaveCSS('box-shadow', ring)
    await expect(chosen).toHaveCSS('outline-style', 'none')

    await page.keyboard.press('ArrowRight')
    await expect(designSystemPage.datePickerDay('April 13, 2026')).toHaveCSS(
      'box-shadow',
      ring,
    )
    await expect(chosen).toHaveCSS('box-shadow', 'none')
  })

  test('a click shows no focus ring, on the button or the day', async ({
    designSystemPage,
  }) => {
    const trigger = designSystemPage.datePickerTrigger

    await trigger.click()
    await expect(trigger).toBeFocused()
    await expect(trigger).toHaveCSS('outline-style', 'none')

    await trigger.click()
    const chosen = designSystemPage.datePickerDay('April 12, 2026')
    await expect(chosen).toBeFocused()
    await expect(chosen).toHaveCSS('box-shadow', 'none')

    await designSystemPage.datePickerDay('April 20, 2026').click()
    await expect(trigger).toBeFocused()
    await expect(trigger).toHaveText('April 20, 2026')
    await expect(trigger).toHaveCSS('outline-style', 'none')
  })

  // The screenshot can't see the hover: --bg-hover is white at 4%, under
  // its color threshold.
  test('the chosen day, today and the hovered day have their own looks', async ({
    designSystemPage,
  }) => {
    const chosen = designSystemPage.datePickerDay('April 12, 2026')
    const today = designSystemPage.datePickerDay('April 14, 2026')
    const other = designSystemPage.datePickerDay('April 15, 2026')
    const muted = designSystemPage.datePickerDay('March 31, 2026')
    // --ink-950.
    await expect(chosen).toHaveCSS('background-color', orange)
    await expect(chosen).toHaveCSS('color', 'rgb(11, 13, 18)')
    await expect(chosen).toHaveCSS('font-weight', '600')
    await expect(today).toHaveCSS('background-color', none)
    await expect(today).toHaveCSS('color', orange)
    await expect(today).toHaveCSS('font-weight', '600')
    // --fg-2 and --ink-500.
    await expect(other).toHaveCSS('color', 'rgb(228, 231, 239)')
    await expect(muted).toHaveCSS('color', 'rgb(58, 65, 82)')
    await expect(other).toHaveCSS('background-color', none)

    await other.hover()
    await expect(other).toHaveCSS('background-color', 'rgba(255, 255, 255, 0.04)')

    await chosen.hover()
    await expect(other).toHaveCSS('background-color', none)
    await expect(chosen).toHaveCSS('background-color', orange)
  })

  // A day that's both chosen and today reads as chosen: the kit's rule
  // order would draw it orange on orange.
  test("a chosen today reads as chosen", async ({ designSystemPage }) => {
    await designSystemPage.datePickerDay('April 14, 2026').click()
    await designSystemPage.datePickerTrigger.click()

    const today = designSystemPage.datePickerDay('April 14, 2026')
    await expect(today).toHaveAttribute('aria-current', 'date')
    await expect(today).toHaveAttribute('aria-selected', 'true')
    await expect(today).toHaveCSS('background-color', orange)
    await expect(today).toHaveCSS('color', 'rgb(11, 13, 18)')
  })

  // Natively the arrows, Home, End and the Page keys scroll the page. The
  // days they move to here stay in the window, so the focus doesn't scroll
  // it either.
  test("the grid's keys don't scroll the page", async ({
    designSystemPage,
    page,
  }) => {
    const chosen = designSystemPage.datePickerDay('April 12, 2026')
    await chosen.evaluate((day) => day.scrollIntoView({ block: 'center' }))
    await chosen.focus()
    const top = await page.locator('html').evaluate((html) => html.scrollTop)
    expect(top).toBeGreaterThan(0)

    for (const [key, name] of [
      ['ArrowDown', 'April 19, 2026'],
      ['End', 'April 25, 2026'],
      ['PageDown', 'May 25, 2026'],
      ['PageUp', 'April 25, 2026'],
      ['Home', 'April 19, 2026'],
    ]) {
      await page.keyboard.press(key)
      await expect(designSystemPage.datePickerDay(name)).toBeFocused()
      expect(await page.locator('html').evaluate((html) => html.scrollTop), key).toBe(top)
    }
  })

  // The demo's picker always has a day chosen, so this test shows the
  // placeholder's class in place.
  test('the placeholder is muted', async ({ designSystemPage }) => {
    const text = designSystemPage.datePickerTrigger.locator('span')
    // --fg-1.
    await expect(text).toHaveCSS('color', 'rgb(247, 248, 251)')

    await text.evaluate((span) => span.classList.add('date-picker-placeholder'))

    // --fg-muted.
    await expect(text).toHaveCSS('color', 'rgb(107, 114, 131)')
  })

  // The demo's picker isn't disabled, so this test disables its button in
  // place, after closing the calendar. That checks the looks: the unit tests
  // check that a disabled picker doesn't open.
  test("a disabled one fades and doesn't open", async ({
    designSystemPage,
    page,
  }) => {
    const trigger = designSystemPage.datePickerTrigger
    await trigger.click()
    await expect(designSystemPage.datePickerDialog).toHaveCount(0)
    await trigger.evaluate((button) => button.setAttribute('disabled', ''))
    const box = (await trigger.boundingBox())!

    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)

    await expect(designSystemPage.datePickerDialog).toHaveCount(0)
    await expect(trigger).toHaveCSS('opacity', '0.5')
    await expect(trigger).toHaveCSS('cursor', 'not-allowed')
  })

  // The demo's picker isn't invalid, so this test marks its button in
  // place. The border fades, so it checks the resting border first: a
  // check made as it faded would still see that color.
  test('an invalid one shows the error border', async ({
    designSystemPage,
  }) => {
    const trigger = designSystemPage.datePickerTrigger
    // --border-default.
    await expect(trigger).toHaveCSS('border-color', 'rgb(58, 65, 82)')

    await trigger.evaluate((button) => button.setAttribute('data-invalid', ''))

    // --loss, #FF4D6D.
    await expect(trigger).toHaveCSS('border-color', 'rgb(255, 77, 109)')
  })

  // The card shows the calendar in the page's flow, as the kit draws it.
  // Without the card's class, it floats under the button, over the page.
  test('the calendar floats under the button without the card class', async ({
    designSystemPage,
  }) => {
    const card = designSystemPage.datePickerCard
    const open = (await card.boundingBox())!

    await designSystemPage.datePicker.evaluate((picker) =>
      picker.classList.remove('date-picker-demo'),
    )

    const dialog = designSystemPage.datePickerDialog
    await expect(dialog).toHaveCSS('position', 'absolute')
    await expect(dialog).toHaveCSS('box-shadow', 'rgba(0, 0, 0, 0.55) 0px 12px 32px 0px')
    const trigger = (await designSystemPage.datePickerTrigger.boundingBox())!
    const calendar = (await dialog.boundingBox())!
    const floating = (await card.boundingBox())!
    expect(calendar.x).toBe(trigger.x)
    expect(calendar.y).toBe(trigger.y + trigger.height + 4)
    expect(calendar.width).toBe(280)
    expect(floating.height).toBeLessThan(open.height)
    expect(calendar.y + calendar.height).toBeGreaterThan(
      floating.y + floating.height,
    )
  })

  test('the day backgrounds fade', async ({ designSystemPage }) => {
    await expect(
      designSystemPage.datePickerDay('April 15, 2026'),
    ).toHaveCSS('transition-duration', '0.12s, 0.12s')
  })

  test.describe('with reduced motion', () => {
    test.use({ reducedMotion: 'reduce' })

    test('the day backgrounds change without a transition', async ({
      designSystemPage,
    }) => {
      await expect(
        designSystemPage.datePickerDay('April 15, 2026'),
      ).toHaveCSS('transition-duration', '0s')
    })
  })
})

// Nothing is hovered or focused, so the card shows Bold and Singles pressed,
// with no focus ring.
test.describe('Toggle · Toggle Group card', () => {
  test('matches the screenshot', async ({ designSystemPage }) => {
    await designSystemPage.goto()

    await expect(designSystemPage.toggleCard).toHaveScreenshot(
      'toggle-card.png',
    )
  })

  test('matches the reference kit card', async ({ referenceKitPage }) => {
    await referenceKitPage.goto()

    await expect(referenceKitPage.toggleCard).toHaveScreenshot(
      'toggle-card.png',
    )
  })
})

// The kit's toggles are static, with no focus style, so the tests below are
// the app's alone.
test.describe('Toggle', () => {
  const orange = 'rgb(255, 122, 26)'
  const none = 'rgba(0, 0, 0, 0)'
  const hover = 'rgba(255, 255, 255, 0.04)'
  // --ink-700, --fg-1 and --fg-2.
  const pressed = 'rgb(31, 36, 48)'
  const fg1 = 'rgb(247, 248, 251)'
  const fg2 = 'rgb(228, 231, 239)'

  test.beforeEach(async ({ designSystemPage }) => {
    await designSystemPage.goto()
  })

  test('a click, Space and Enter flip a toggle', async ({
    designSystemPage,
    page,
  }) => {
    const bold = designSystemPage.toggle('Bold')
    const italic = designSystemPage.toggle('Italic')
    await expect(bold).toHaveAttribute('aria-pressed', 'true')
    await expect(italic).toHaveAttribute('aria-pressed', 'false')

    await italic.click()
    await expect(italic).toHaveAttribute('aria-pressed', 'true')

    await bold.focus()
    await page.keyboard.press('Space')
    await expect(bold).toHaveAttribute('aria-pressed', 'false')
    await page.keyboard.press('Enter')
    await expect(bold).toHaveAttribute('aria-pressed', 'true')
  })

  test("a click or an arrow key moves the group's choice", async ({
    designSystemPage,
    page,
  }) => {
    const singles = designSystemPage.toggleGroupItem('Singles')
    const doubles = designSystemPage.toggleGroupItem('Doubles')
    const mixed = designSystemPage.toggleGroupItem('Mixed')
    await expect(singles).toHaveAttribute('aria-checked', 'true')

    await doubles.click()
    await expect(doubles).toHaveAttribute('aria-checked', 'true')
    await expect(singles).toHaveAttribute('aria-checked', 'false')

    await page.keyboard.press('ArrowRight')
    await expect(mixed).toBeFocused()
    await expect(mixed).toHaveAttribute('aria-checked', 'true')
    await page.keyboard.press('ArrowRight')
    await expect(singles).toBeFocused()
    await expect(singles).toHaveAttribute('aria-checked', 'true')
    await page.keyboard.press('ArrowLeft')
    await expect(mixed).toBeFocused()
    await expect(mixed).toHaveAttribute('aria-checked', 'true')
    await expect(doubles).toHaveAttribute('aria-checked', 'false')
  })

  // Natively the arrows scroll the page.
  test("the group's arrow keys don't scroll the page", async ({
    designSystemPage,
    page,
  }) => {
    const singles = designSystemPage.toggleGroupItem('Singles')
    await singles.evaluate((item) => item.scrollIntoView({ block: 'center' }))
    await singles.focus()
    const top = await page.locator('html').evaluate((html) => html.scrollTop)
    expect(top).toBeGreaterThan(0)

    for (const [key, name] of [
      ['ArrowDown', 'Doubles'],
      ['ArrowRight', 'Mixed'],
      ['ArrowUp', 'Doubles'],
      ['ArrowLeft', 'Singles'],
    ]) {
      await page.keyboard.press(key)
      await expect(designSystemPage.toggleGroupItem(name)).toBeFocused()
      expect(
        await page.locator('html').evaluate((html) => html.scrollTop),
        key,
      ).toBe(top)
    }
  })

  // A toggle is a button, so it takes the .button outline, on keyboard
  // focus only. The group is one Tab stop, on its chosen item.
  test('keyboard focus shows the outline', async ({
    designSystemPage,
    page,
  }) => {
    const bold = designSystemPage.toggle('Bold')
    const italic = designSystemPage.toggle('Italic')
    const singles = designSystemPage.toggleGroupItem('Singles')
    const doubles = designSystemPage.toggleGroupItem('Doubles')
    await bold.focus()

    await page.keyboard.press('Tab')
    await expect(italic).toBeFocused()
    await expect(italic).toHaveCSS('outline', `${orange} solid 2px`)
    await expect(italic).toHaveCSS('outline-offset', '2px')
    await expect(bold).toHaveCSS('outline-style', 'none')

    await page.keyboard.press('Tab')
    await expect(singles).toBeFocused()
    await expect(singles).toHaveCSS('outline', `${orange} solid 2px`)

    await page.keyboard.press('ArrowRight')
    await expect(doubles).toBeFocused()
    await expect(doubles).toHaveCSS('outline', `${orange} solid 2px`)
    await expect(singles).toHaveCSS('outline-style', 'none')
  })

  test('a click shows no outline, on a toggle or a group item', async ({
    designSystemPage,
  }) => {
    const italic = designSystemPage.toggle('Italic')
    const doubles = designSystemPage.toggleGroupItem('Doubles')

    await italic.click()
    await expect(italic).toBeFocused()
    await expect(italic).toHaveCSS('outline-style', 'none')

    await doubles.click()
    await expect(doubles).toBeFocused()
    await expect(doubles).toHaveCSS('outline-style', 'none')
  })

  // The screenshot can't see the hover: --bg-hover is white at 4%, under
  // its color threshold. The backgrounds fade, so each test checks the
  // starting look before it changes anything.
  test('hovering an unpressed toggle lightens it', async ({
    designSystemPage,
  }) => {
    const italic = designSystemPage.toggle('Italic')
    await expect(italic).toHaveCSS('background-color', none)
    await expect(italic).toHaveCSS('color', fg2)

    await italic.hover()

    await expect(italic).toHaveCSS('background-color', hover)
    await expect(italic).toHaveCSS('color', fg1)
  })

  test('pressing a hovered toggle darkens it', async ({
    designSystemPage,
  }) => {
    const italic = designSystemPage.toggle('Italic')
    await italic.hover()
    await expect(italic).toHaveCSS('background-color', hover)

    await italic.click()

    await expect(italic).toHaveAttribute('aria-pressed', 'true')
    await expect(italic).toHaveCSS('background-color', pressed)
    await expect(italic).toHaveCSS('color', fg1)
  })

  // A look that stays the same would pass a check made before the
  // transition starts, so this one runs without transitions.
  test.describe('without transitions', () => {
    test.use({ reducedMotion: 'reduce' })

    test('a pressed toggle and the chosen item keep their look under the pointer', async ({
      designSystemPage,
    }) => {
      const bold = designSystemPage.toggle('Bold')
      const singles = designSystemPage.toggleGroupItem('Singles')
      for (const toggle of [bold, singles]) {
        await expect(toggle).toHaveCSS('background-color', pressed)
        await expect(toggle).toHaveCSS('color', fg1)

        await toggle.hover()

        await expect(toggle).toHaveCSS('background-color', pressed)
        await expect(toggle).toHaveCSS('color', fg1)
      }
    })
  })

  test("the group's items look like toggles in a panel", async ({
    designSystemPage,
  }) => {
    const group = designSystemPage.toggleGroup
    // --ink-900 and --border-subtle.
    await expect(group).toHaveCSS('background-color', 'rgb(17, 20, 27)')
    await expect(group).toHaveCSS('border-color', 'rgb(42, 48, 64)')
    await expect(group).toHaveCSS('border-radius', '10px')
    const doubles = designSystemPage.toggleGroupItem('Doubles')
    await expect(doubles).toHaveCSS('background-color', none)
    await expect(doubles).toHaveCSS('color', fg2)
    await expect(doubles).toHaveCSS('border-radius', '6px')
  })

  test('the separator is a 1px line as tall as the row', async ({
    designSystemPage,
  }) => {
    const separator = designSystemPage.toggleSeparator
    await expect(separator).toHaveAttribute('aria-orientation', 'vertical')
    // --border-subtle.
    await expect(separator).toHaveCSS('background-color', 'rgb(42, 48, 64)')
    const line = (await separator.boundingBox())!
    const row = (await designSystemPage.toggleRow.boundingBox())!
    expect(line.width).toBe(1)
    expect(row.height).toBe(46)
    expect(line.height).toBe(row.height)
    expect(line.y).toBe(row.y)
  })

  // The demo has no disabled toggles, so this test disables a toggle and an
  // item in place. That checks the looks: the unit tests check the rest.
  test("a disabled toggle or item fades and doesn't change", async ({
    designSystemPage,
    page,
  }) => {
    const italic = designSystemPage.toggle('Italic')
    const doubles = designSystemPage.toggleGroupItem('Doubles')
    for (const toggle of [italic, doubles]) {
      await expect(toggle).toHaveCSS('opacity', '1')
      await toggle.evaluate((button) => button.setAttribute('disabled', ''))
      const box = (await toggle.boundingBox())!

      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)

      await expect(toggle).toHaveCSS('opacity', '0.5')
      await expect(toggle).toHaveCSS('cursor', 'not-allowed')
    }
    await expect(italic).toHaveAttribute('aria-pressed', 'false')
    await expect(doubles).toHaveAttribute('aria-checked', 'false')
    await expect(
      designSystemPage.toggleGroupItem('Singles'),
    ).toHaveAttribute('aria-checked', 'true')
  })

  test('the background and text color fade', async ({ designSystemPage }) => {
    await expect(designSystemPage.toggle('Italic')).toHaveCSS(
      'transition-duration',
      '0.12s, 0.12s',
    )
  })

  test.describe('with reduced motion', () => {
    test.use({ reducedMotion: 'reduce' })

    test('the background and text color change without a transition', async ({
      designSystemPage,
    }) => {
      await expect(designSystemPage.toggle('Italic')).toHaveCSS(
        'transition-duration',
        '0s',
      )
    })
  })
})

test.describe('Data Display section', () => {
  test('matches the screenshot', async ({ designSystemPage }) => {
    await designSystemPage.goto()

    await expect(designSystemPage.displaySectionHeading).toHaveScreenshot(
      'display-heading.png',
    )
    await expect(designSystemPage.displaySectionLead).toHaveScreenshot(
      'display-lead.png',
    )
  })

  test('matches the reference kit section', async ({ referenceKitPage }) => {
    await referenceKitPage.goto()

    await expect(referenceKitPage.displaySectionHeading).toHaveScreenshot(
      'display-heading.png',
    )
    await expect(referenceKitPage.displaySectionLead).toHaveScreenshot(
      'display-lead.png',
    )
  })
})

// Nothing is hovered or focused, so the buttons show their resting styles.
test.describe('Card card', () => {
  test('matches the screenshot', async ({ designSystemPage }) => {
    await designSystemPage.goto()

    await expect(designSystemPage.cardCard).toHaveScreenshot('card-card.png')
  })

  test('matches the reference kit card', async ({ referenceKitPage }) => {
    await referenceKitPage.goto()

    await expect(referenceKitPage.cardCard).toHaveScreenshot('card-card.png')
  })
})

// Both screenshots stop the live dot's pulse at its first frame, so they
// match whenever they're taken.
test.describe('Badge card', () => {
  test('matches the screenshot', async ({ designSystemPage }) => {
    await designSystemPage.goto()

    await expect(designSystemPage.badgeCard).toHaveScreenshot(
      'badge-card.png',
      { animations: 'disabled' },
    )
  })

  test('matches the reference kit card', async ({ referenceKitPage }) => {
    await referenceKitPage.goto()

    await expect(referenceKitPage.badgeCard).toHaveScreenshot(
      'badge-card.png',
      { animations: 'disabled' },
    )
  })

  test("the live badge's dot pulses", async ({ designSystemPage }) => {
    await designSystemPage.goto()

    await expect(designSystemPage.liveDot).toHaveCSS(
      'animation-name',
      'ball-pulse',
    )
  })

  test.describe('with reduced motion', () => {
    test.use({ reducedMotion: 'reduce' })

    test("the live badge's dot holds still", async ({ designSystemPage }) => {
      await designSystemPage.goto()

      await expect(designSystemPage.liveDot).toHaveCSS('animation-name', 'none')
    })
  })
})

test.describe('Avatar card', () => {
  test('matches the screenshot', async ({ designSystemPage }) => {
    await designSystemPage.goto()

    await expect(designSystemPage.avatarCard).toHaveScreenshot(
      'avatar-card.png',
    )
  })

  test('matches the reference kit card', async ({ referenceKitPage }) => {
    await referenceKitPage.goto()

    await expect(referenceKitPage.avatarCard).toHaveScreenshot(
      'avatar-card.png',
    )
  })
})

test.describe('Table · Data Table card', () => {
  test('matches the screenshot', async ({ designSystemPage }) => {
    await designSystemPage.goto()

    await expect(designSystemPage.tableCard).toHaveScreenshot('table-card.png')
  })

  test('matches the reference kit card', async ({ referenceKitPage }) => {
    await referenceKitPage.goto()

    await expect(referenceKitPage.tableCard).toHaveScreenshot('table-card.png')
  })
})

test.describe('Progress card', () => {
  test('matches the screenshot', async ({ designSystemPage }) => {
    await designSystemPage.goto()

    await expect(designSystemPage.progressCard).toHaveScreenshot(
      'progress-card.png',
    )
  })

  test('matches the reference kit card', async ({ referenceKitPage }) => {
    await referenceKitPage.goto()

    await expect(referenceKitPage.progressCard).toHaveScreenshot(
      'progress-card.png',
    )
  })
})

// Both screenshots stop the shimmer at its first frame, so they match
// whenever they're taken.
test.describe('Skeleton card', () => {
  test('matches the screenshot', async ({ designSystemPage }) => {
    await designSystemPage.goto()

    await expect(designSystemPage.skeletonCard).toHaveScreenshot(
      'skeleton-card.png',
      { animations: 'disabled' },
    )
  })

  test('matches the reference kit card', async ({ referenceKitPage }) => {
    await referenceKitPage.goto()

    await expect(referenceKitPage.skeletonCard).toHaveScreenshot(
      'skeleton-card.png',
      { animations: 'disabled' },
    )
  })

  test('the placeholders shimmer', async ({ designSystemPage }) => {
    await designSystemPage.goto()

    await expect(designSystemPage.skeleton).toHaveCSS('animation-name', 'skel')
  })

  test.describe('with reduced motion', () => {
    test.use({ reducedMotion: 'reduce' })

    test('the placeholders hold still', async ({ designSystemPage }) => {
      await designSystemPage.goto()

      await expect(designSystemPage.skeleton).toHaveCSS('animation-name', 'none')
    })
  })
})

// The kit's card overflows: its grid stretches the 1:1 box to the 16:9
// box's height (511px at 1280px wide), so the square is 511px wide too and
// the page scrolls sideways by 276px. The app keeps each box's own height,
// so its screenshot is its own, not the kit's.
test.describe('Aspect Ratio card', () => {
  test('matches the screenshot', async ({ designSystemPage }) => {
    await designSystemPage.goto()

    await expect(designSystemPage.aspectRatioCard).toHaveScreenshot(
      'aspect-ratio-card.png',
    )
  })

  test('its boxes keep their ratios inside the card', async ({
    designSystemPage,
    page,
  }) => {
    await designSystemPage.goto()
    const card = (await designSystemPage.aspectRatioCard.boundingBox())!
    const wide = (await designSystemPage.aspectRatioBox('16 : 9').boundingBox())!
    const square = (await designSystemPage
      .aspectRatioBox('1 : 1')
      .boundingBox())!

    expect(wide.width / wide.height).toBeCloseTo(16 / 9, 2)
    expect(square.width).toBeCloseTo(square.height, 0)
    expect(square.width).toBeCloseTo(wide.width, 0)
    // Inside the card's 1px border and 32px padding on the right.
    expect(square.x + square.width).toBeLessThanOrEqual(
      card.x + card.width - 33,
    )
    expect(
      await page
        .locator('html')
        .evaluate((html) => html.scrollWidth - html.clientWidth),
    ).toBeLessThanOrEqual(0)
  })
})

test.describe('Navigation section', () => {
  test('matches the screenshot', async ({ designSystemPage }) => {
    await designSystemPage.goto()

    await expect(designSystemPage.navSectionHeading).toHaveScreenshot(
      'nav-heading.png',
    )
    await expect(designSystemPage.navSectionLead).toHaveScreenshot(
      'nav-lead.png',
    )
  })

  test('matches the reference kit section', async ({ referenceKitPage }) => {
    await referenceKitPage.goto()

    await expect(referenceKitPage.navSectionHeading).toHaveScreenshot(
      'nav-heading.png',
    )
    await expect(referenceKitPage.navSectionLead).toHaveScreenshot(
      'nav-lead.png',
    )
  })
})

// Nothing is focused first, so the tabs show their resting styles.
test.describe('Tabs card', () => {
  test('matches the screenshot', async ({ designSystemPage }) => {
    await designSystemPage.goto()

    await expect(designSystemPage.tabsCard).toHaveScreenshot('tabs-card.png')
  })

  test('matches the reference kit card', async ({ referenceKitPage }) => {
    await referenceKitPage.goto()

    await expect(referenceKitPage.tabsCard).toHaveScreenshot('tabs-card.png')
  })
})

// The kit's tabs are static, with no focus style, so the tests below are
// the app's alone.
test.describe('Tabs', () => {
  const orange = 'rgb(255, 122, 26)'

  test.beforeEach(async ({ designSystemPage }) => {
    await designSystemPage.goto()
  })

  test('a click chooses a tab and shows its panel', async ({
    designSystemPage,
  }) => {
    const schedule = designSystemPage.tab('Schedule')

    await schedule.click()

    await expect(schedule).toHaveAttribute('aria-selected', 'true')
    await expect(designSystemPage.tab('Overview')).toHaveAttribute(
      'aria-selected',
      'false',
    )
    await expect(designSystemPage.tabPanel).toHaveText(
      'Round 3 starts at 2:00pm — 16 matches across 4 courts.',
    )
  })

  // Natively the arrows, Home and End scroll the page.
  test("the arrow keys, Home and End move the choice, and don't scroll the page", async ({
    designSystemPage,
    page,
  }) => {
    const overview = designSystemPage.tab('Overview')
    await overview.evaluate((tab) => tab.scrollIntoView({ block: 'center' }))
    await overview.focus()
    const top = await page.locator('html').evaluate((html) => html.scrollTop)
    expect(top).toBeGreaterThan(0)

    for (const [key, name] of [
      ['ArrowRight', 'Schedule'],
      ['End', 'Players'],
      ['ArrowRight', 'Overview'],
      ['ArrowLeft', 'Players'],
      ['Home', 'Overview'],
    ]) {
      await page.keyboard.press(key)
      const tab = designSystemPage.tab(name)
      await expect(tab, key).toBeFocused()
      await expect(tab, key).toHaveAttribute('aria-selected', 'true')
      expect(
        await page.locator('html').evaluate((html) => html.scrollTop),
        key,
      ).toBe(top)
    }
  })

  test('keyboard focus shows the outline', async ({
    designSystemPage,
    page,
  }) => {
    const overview = designSystemPage.tab('Overview')
    const schedule = designSystemPage.tab('Schedule')
    await overview.focus()
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Tab')

    await expect(overview).toBeFocused()
    await expect(overview).toHaveCSS('outline', `${orange} solid 2px`)
    await expect(overview).toHaveCSS('outline-offset', '2px')

    await page.keyboard.press('ArrowRight')
    await expect(schedule).toBeFocused()
    await expect(schedule).toHaveCSS('outline', `${orange} solid 2px`)
    await expect(overview).toHaveCSS('outline-style', 'none')
  })

  test('a click shows no outline', async ({ designSystemPage }) => {
    const schedule = designSystemPage.tab('Schedule')

    await schedule.click()

    await expect(schedule).toBeFocused()
    await expect(schedule).toHaveCSS('outline-style', 'none')
  })
})

// Both screenshots finish the chevron's turn, so they match whenever
// they're taken.
test.describe('Accordion card', () => {
  test('matches the screenshot', async ({ designSystemPage }) => {
    await designSystemPage.goto()

    await expect(designSystemPage.accordionCard).toHaveScreenshot(
      'accordion-card.png',
      { animations: 'disabled' },
    )
  })

  test('matches the reference kit card', async ({ referenceKitPage }) => {
    await referenceKitPage.goto()

    await expect(referenceKitPage.accordionCard).toHaveScreenshot(
      'accordion-card.png',
      { animations: 'disabled' },
    )
  })
})

// The kit's accordion is static, with no focus style, so the tests below
// are the app's alone.
test.describe('Accordion', () => {
  const orange = 'rgb(255, 122, 26)'
  const scheduler = 'How does the SMT scheduler work?'
  const free = 'Is FortyMM really free?'

  test.beforeEach(async ({ designSystemPage }) => {
    await designSystemPage.goto()
  })

  test('a click opens and closes each question on its own', async ({
    designSystemPage,
  }) => {
    const first = designSystemPage.accordionTrigger(scheduler)
    const second = designSystemPage.accordionTrigger(free)
    await expect(designSystemPage.accordionContent(scheduler)).toBeVisible()
    await expect(designSystemPage.accordionContent(free)).toHaveCount(0)

    await second.click()
    await expect(second).toHaveAttribute('aria-expanded', 'true')
    await expect(designSystemPage.accordionContent(free)).toBeVisible()
    await expect(first).toHaveAttribute('aria-expanded', 'true')

    await first.click()
    await expect(first).toHaveAttribute('aria-expanded', 'false')
    await expect(designSystemPage.accordionContent(scheduler)).toHaveCount(0)
    await expect(designSystemPage.accordionContent(free)).toBeVisible()
  })

  test('Enter and Space open and close a question', async ({
    designSystemPage,
    page,
  }) => {
    const second = designSystemPage.accordionTrigger(free)
    await second.focus()

    await page.keyboard.press('Enter')
    await expect(second).toHaveAttribute('aria-expanded', 'true')
    await page.keyboard.press('Space')
    await expect(second).toHaveAttribute('aria-expanded', 'false')
  })

  test("an open question's chevron points up", async ({
    designSystemPage,
  }) => {
    const chevron = designSystemPage.accordionChevron(free)
    await expect(chevron).toHaveCSS('transform', 'none')

    await designSystemPage.accordionTrigger(free).click()

    // rotate(180deg).
    await expect(chevron).toHaveCSS('transform', 'matrix(-1, 0, 0, -1, 0, 0)')
  })

  test('the chevron turns', async ({ designSystemPage }) => {
    await expect(designSystemPage.accordionChevron(free)).toHaveCSS(
      'transition-duration',
      '0.12s',
    )
  })

  test('keyboard focus shows the outline', async ({
    designSystemPage,
    page,
  }) => {
    const first = designSystemPage.accordionTrigger(scheduler)
    const second = designSystemPage.accordionTrigger(free)
    await first.focus()

    await page.keyboard.press('Tab')
    await expect(second).toBeFocused()
    await expect(second).toHaveCSS('outline', `${orange} solid 2px`)
    await expect(second).toHaveCSS('outline-offset', '2px')
    await expect(first).toHaveCSS('outline-style', 'none')
  })

  test('a click shows no outline', async ({ designSystemPage }) => {
    const second = designSystemPage.accordionTrigger(free)

    await second.click()

    await expect(second).toBeFocused()
    await expect(second).toHaveCSS('outline-style', 'none')
  })

  test.describe('with reduced motion', () => {
    test.use({ reducedMotion: 'reduce' })

    test('the chevron turns without a transition', async ({
      designSystemPage,
    }) => {
      await expect(designSystemPage.accordionChevron(free)).toHaveCSS(
        'transition-duration',
        '0s',
      )
    })
  })
})

// Nothing is hovered or focused first, so the links show their resting
// styles.
test.describe('Breadcrumb card', () => {
  test('matches the screenshot', async ({ designSystemPage }) => {
    await designSystemPage.goto()

    await expect(designSystemPage.breadcrumbCard).toHaveScreenshot(
      'breadcrumb-card.png',
    )
  })

  test('matches the reference kit card', async ({ referenceKitPage }) => {
    await referenceKitPage.goto()

    await expect(referenceKitPage.breadcrumbCard).toHaveScreenshot(
      'breadcrumb-card.png',
    )
  })
})

test.describe('Breadcrumb', () => {
  const orange = 'rgb(255, 122, 26)'
  // --fg-3 and --fg-1.
  const fg3 = 'rgb(169, 176, 194)'
  const fg1 = 'rgb(247, 248, 251)'

  test.beforeEach(async ({ designSystemPage }) => {
    await designSystemPage.goto()
  })

  test('hovering a link lightens it', async ({ designSystemPage }) => {
    const link = designSystemPage.breadcrumbLink('Tournaments')
    await expect(link).toHaveCSS('color', fg3)

    await link.hover()

    await expect(link).toHaveCSS('color', fg1)
  })

  // The kit's links have no focus style, so this is the app's alone.
  test('keyboard focus shows the outline', async ({
    designSystemPage,
    page,
  }) => {
    const first = designSystemPage.breadcrumbLink('Tournaments')
    const second = designSystemPage.breadcrumbLink('April Spring Open')
    await first.focus()

    await page.keyboard.press('Tab')

    await expect(second).toBeFocused()
    await expect(second).toHaveCSS('outline', `${orange} solid 2px`)
    await expect(second).toHaveCSS('outline-offset', '2px')
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

  // A label too long for its row wraps beside the track, which stays on the
  // right, vertically centred, rather than wrapping under the text.
  test('a long switch label wraps beside its track', async ({
    designSystemPage,
  }) => {
    await designSystemPage.goto()
    const name = 'Notify me of nearby matches'
    const card = (await designSystemPage.switchCard.boundingBox())!
    const row = (await designSystemPage.switchLabel(name).boundingBox())!
    const text = (await designSystemPage.switchText(name).boundingBox())!
    const track = (await designSystemPage.switchTrack(name).boundingBox())!

    // Inside the card's 1px border and 32px padding on the right.
    expect(row.x + row.width).toBeLessThanOrEqual(card.x + card.width - 33)
    expect(text.height).toBeGreaterThan(21)
    expect(track.x).toBeGreaterThanOrEqual(text.x + text.width + 12)
    expect(track.x + track.width).toBeCloseTo(row.x + row.width, 0)
    expect(track.y + track.height / 2).toBeCloseTo(row.y + row.height / 2, 0)
  })

  // The track narrows to fit, and the thumbs keep their places along it.
  test('the slider card fits', async ({ designSystemPage, page }) => {
    await designSystemPage.goto()

    for (const element of [designSystemPage.sliderCard, page.locator('html')]) {
      expect(
        await element.evaluate((e) => e.scrollWidth - e.clientWidth),
      ).toBe(0)
    }
    for (const [label, name, fraction] of [
      ['Skill level', 'Skill level', 0.55],
      ['Rating range', 'Rating range minimum', 0.3],
      ['Rating range', 'Rating range maximum', 0.7],
    ] as const) {
      const track = (await designSystemPage.sliderTrack(label).boundingBox())!
      const thumb = (await designSystemPage.sliderThumb(name).boundingBox())!
      expect(track.width).toBeLessThan(480)
      expect(thumb.x + thumb.width / 2).toBeCloseTo(
        track.x + track.width * fraction,
        0,
      )
    }
  })

  // The selects size to their options, and the row wraps them to fit the
  // card.
  test('the select card fits', async ({ designSystemPage, page }) => {
    await designSystemPage.goto()

    for (const element of [designSystemPage.selectCard, page.locator('html')]) {
      expect(
        await element.evaluate((e) => e.scrollWidth - e.clientWidth),
      ).toBe(0)
    }
    const card = (await designSystemPage.selectCard.boundingBox())!
    for (const name of ['Match type', 'Match length']) {
      const select = (await designSystemPage.select(name).boundingBox())!
      // Inside the card's 1px border and 32px padding on the right.
      expect(select.x + select.width).toBeLessThanOrEqual(
        card.x + card.width - 33,
      )
    }
  })

  // The box narrows from the kit's 340px to the card's content, and its
  // input narrows with it. An input that kept its default width would
  // squeeze the icon here, and overflow the box on a narrower phone.
  test('the combobox card fits', async ({ designSystemPage, page }) => {
    await designSystemPage.goto()

    for (const element of [
      designSystemPage.comboboxCard,
      page.locator('html'),
    ]) {
      expect(
        await element.evaluate((e) => e.scrollWidth - e.clientWidth),
      ).toBe(0)
    }
    const card = (await designSystemPage.comboboxCard.boundingBox())!
    const box = (await designSystemPage.comboboxBox.boundingBox())!
    const input = (await designSystemPage.combobox.boundingBox())!
    // Inside the card's 1px border and 32px padding on the right.
    expect(box.x + box.width).toBeLessThanOrEqual(card.x + card.width - 33)
    // The box clips what overflows it, so check the input stays inside too.
    expect(input.x + input.width).toBeLessThanOrEqual(box.x + box.width)
    expect((await designSystemPage.comboboxIcon.boundingBox())!.width).toBe(14)
  })

  // The row wraps the calendar under the button, as the kit's does. The
  // card's content is 228px wide here, and the calendar, a flex item,
  // shrinks from its 280px to fit.
  test('the date picker card fits', async ({ designSystemPage, page }) => {
    await page.clock.setFixedTime(new Date(2026, 3, 14, 12))
    await designSystemPage.goto()

    for (const element of [
      designSystemPage.datePickerCard,
      page.locator('html'),
    ]) {
      expect(
        await element.evaluate((e) => e.scrollWidth - e.clientWidth),
      ).toBe(0)
    }
    const card = (await designSystemPage.datePickerCard.boundingBox())!
    const label = (await designSystemPage.datePickerLabel.boundingBox())!
    const trigger = (await designSystemPage.datePickerTrigger.boundingBox())!
    const calendar = (await designSystemPage.datePickerDialog.boundingBox())!
    // Inside the card's 1px border and 32px padding on the right.
    const right = card.x + card.width - 33
    expect(trigger.width).toBe(200)
    expect(trigger.x + trigger.width).toBeLessThanOrEqual(right)
    expect(calendar.width).toBeLessThan(280)
    expect(calendar.x).toBe(label.x)
    expect(calendar.x + calendar.width).toBe(right)
    // The row's 24px gap, under the button.
    expect(calendar.y).toBe(trigger.y + trigger.height + 24)
    for (const name of ['March 29, 2026', 'May 2, 2026']) {
      const day = (await designSystemPage.datePickerDay(name).boundingBox())!
      expect(day.x).toBeGreaterThanOrEqual(calendar.x)
      expect(day.x + day.width).toBeLessThanOrEqual(
        calendar.x + calendar.width,
      )
    }
  })

  // The row wraps the group under B, I and the separator, as the kit's
  // does. The card's content is 228px wide here, narrower than the kit's
  // 242px group, so the group's items take less padding to fit.
  test('the toggle card fits', async ({ designSystemPage, page }) => {
    await designSystemPage.goto()

    for (const element of [
      designSystemPage.toggleCard,
      page.locator('html'),
    ]) {
      expect(
        await element.evaluate((e) => e.scrollWidth - e.clientWidth),
      ).toBe(0)
    }
    const card = (await designSystemPage.toggleCard.boundingBox())!
    const bold = (await designSystemPage.toggle('Bold').boundingBox())!
    const italic = (await designSystemPage.toggle('Italic').boundingBox())!
    const separator = (await designSystemPage.toggleSeparator.boundingBox())!
    const group = (await designSystemPage.toggleGroup.boundingBox())!
    // Inside the card's 1px border and 32px padding on each side.
    const left = card.x + 33
    const right = card.x + card.width - 33
    expect(bold.x).toBe(left)
    expect(italic.y).toBe(bold.y)
    expect(separator.x).toBeGreaterThan(italic.x + italic.width)
    expect(separator.height).toBe(bold.height)
    expect(group.x).toBe(left)
    // The row's 12px gap, under the first line.
    expect(group.y).toBe(bold.y + bold.height + 12)
    expect(group.x + group.width).toBeLessThanOrEqual(right)
    for (const name of ['Singles', 'Doubles', 'Mixed']) {
      const item = (await designSystemPage
        .toggleGroupItem(name)
        .boundingBox())!
      expect(item.x + item.width, name).toBeLessThanOrEqual(
        group.x + group.width,
      )
    }
  })

  // The row of tabs is wider than the card's content, so the tabs wrap
  // onto more lines, inside the card.
  test('the tabs card fits', async ({ designSystemPage, page }) => {
    await designSystemPage.goto()

    for (const element of [designSystemPage.tabsCard, page.locator('html')]) {
      expect(
        await element.evaluate((e) => e.scrollWidth - e.clientWidth),
      ).toBe(0)
    }
    const card = (await designSystemPage.tabsCard.boundingBox())!
    const list = (await designSystemPage.tabList.boundingBox())!
    const first = (await designSystemPage.tab('Overview').boundingBox())!
    const last = (await designSystemPage.tab('Players').boundingBox())!
    // Inside the card's 1px border and 32px padding on the right.
    expect(list.x + list.width).toBeLessThanOrEqual(card.x + card.width - 33)
    expect(last.y).toBeGreaterThan(first.y)
    expect(last.x + last.width).toBeLessThanOrEqual(list.x + list.width)
  })

  // The trail is wider than the card's content, so its items wrap onto
  // more lines, inside the card.
  test('the breadcrumb card fits', async ({ designSystemPage }) => {
    await designSystemPage.goto()

    expect(
      await designSystemPage.breadcrumbCard.evaluate(
        (e) => e.scrollWidth - e.clientWidth,
      ),
    ).toBe(0)
    const card = (await designSystemPage.breadcrumbCard.boundingBox())!
    const trail = (await designSystemPage.breadcrumb.boundingBox())!
    const first = (await designSystemPage
      .breadcrumbLink('Tournaments')
      .boundingBox())!
    const current = (await designSystemPage.breadcrumb
      .getByText('Round 3')
      .boundingBox())!
    // Inside the card's 1px border and 32px padding on the right.
    expect(trail.x + trail.width).toBeLessThanOrEqual(card.x + card.width - 33)
    expect(current.y).toBeGreaterThan(first.y)
  })

  // The cards share the .grid-2 layout with the input card's fields, so
  // they stack too.
  test("the card card's cards stack", async ({ designSystemPage, page }) => {
    await designSystemPage.goto()
    const first = (await designSystemPage
      .demoCard('April Spring Open')
      .boundingBox())!
    const second = (await designSystemPage
      .demoCard('★ Featured')
      .boundingBox())!

    expect(second.x).toBe(first.x)
    expect(second.width).toBe(first.width)
    expect(second.y).toBeGreaterThanOrEqual(first.y + first.height)
    expect(
      await page
        .locator('html')
        .evaluate((html) => html.scrollWidth - html.clientWidth),
    ).toBeLessThanOrEqual(0)
  })

  // Five badges are wider than the card's content on a phone, so the row
  // wraps them onto more lines rather than scrolling the page sideways.
  test("the badge card's badges wrap", async ({ designSystemPage, page }) => {
    await designSystemPage.goto()
    const card = (await designSystemPage.badgeCard.boundingBox())!
    const first = (await designSystemPage.badge('Seed 1').boundingBox())!
    const last = (await designSystemPage
      .badge('Live · Court 3')
      .boundingBox())!

    expect(last.y).toBeGreaterThan(first.y)
    expect(last.x + last.width).toBeLessThanOrEqual(card.x + card.width - 32)
    expect(
      await page
        .locator('html')
        .evaluate((html) => html.scrollWidth - html.clientWidth),
    ).toBeLessThanOrEqual(0)
  })

  test("the avatar card's avatars stay in the card, the group stacked", async ({
    designSystemPage,
    page,
  }) => {
    await designSystemPage.goto()
    const card = (await designSystemPage.avatarCard.boundingBox())!
    // The row's avatar comes first, before the group's of the same name.
    const rowLast = (await designSystemPage
      .avatars('Marta Kowalski')
      .first()
      .boundingBox())!
    const group = (await designSystemPage.avatarGroup.boundingBox())!

    expect(rowLast.x + rowLast.width).toBeLessThanOrEqual(
      card.x + card.width - 32,
    )
    expect(group.x + group.width).toBeLessThanOrEqual(card.x + card.width - 32)
    expect(
      await page
        .locator('html')
        .evaluate((html) => html.scrollWidth - html.clientWidth),
    ).toBeLessThanOrEqual(0)

    const stacked = await designSystemPage.avatarGroup.getByRole('img').all()
    expect(stacked).toHaveLength(4)
    for (let i = 1; i < stacked.length; i++) {
      const previous = (await stacked[i - 1].boundingBox())!
      const current = (await stacked[i].boundingBox())!
      expect(current.x).toBeLessThan(previous.x + previous.width)
    }
  })

  // The table is wider than a phone, so it scrolls sideways inside the card
  // rather than widening the page, and each row stays on one line.
  test('the standings table scrolls in its card, a row per line', async ({
    designSystemPage,
    page,
  }) => {
    await designSystemPage.goto()
    const scroller = designSystemPage.standingsTable.locator('xpath=..')

    expect(
      await scroller.evaluate((e) => e.scrollWidth - e.clientWidth),
    ).toBeGreaterThan(0)
    expect(
      await page
        .locator('html')
        .evaluate((html) => html.scrollWidth - html.clientWidth),
    ).toBeLessThanOrEqual(0)

    // A row on one line is as tall as its avatar and the cells' 14px padding
    // above and below it. A wrapped name or club makes it taller.
    for (const row of await designSystemPage.standingsTable
      .getByRole('row')
      .all()
      .then((rows) => rows.slice(1))) {
      const avatar = (await row.getByRole('img').boundingBox())!
      const box = (await row.boundingBox())!
      expect(box.height).toBeLessThanOrEqual(avatar.height + 2 * 14 + 1)
    }
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

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

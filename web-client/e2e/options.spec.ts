import { optionPath, options } from '../src/pages/options/catalog.ts'
import { expect, test } from './fixtures.ts'

const widths = [1280, 390]

test('the options page links to every option', async ({ optionsPage }) => {
  await optionsPage.goto()

  await expect(optionsPage.title).toHaveText('Options')
  for (const option of options) {
    await expect(optionsPage.link(option.title)).toHaveAttribute(
      'href',
      optionPath(option.slug),
    )
  }
})

for (const option of options) {
  test(`${option.title} shows its name and fits the window`, async ({ optionsPage, page }) => {
    for (const width of widths) {
      await test.step(`${width}px wide`, async () => {
        await page.setViewportSize({ width, height: 900 })
        await optionsPage.goto(optionPath(option.slug))

        await expect(optionsPage.optionName).toHaveText(option.title)
        await expect(optionsPage.title).toBeVisible()
        expect(await optionsPage.overflow()).toBe(0)
      })
    }
  })
}

for (const option of options.filter((option) => option.kind === 'loading')) {
  test(`${option.title} runs no infinite or idle animation`, async ({ optionsPage, page }) => {
    for (const reducedMotion of ['no-preference', 'reduce'] as const) {
      await test.step(`reduced motion: ${reducedMotion}`, async () => {
        await page.emulateMedia({ reducedMotion })
        await optionsPage.goto(optionPath(option.slug))
        await expect(optionsPage.loadingScreens).toHaveCount(2)
        await page.waitForTimeout(1000)

        const animations = await optionsPage.animations()
        expect(animations.filter((animation) => !Number.isFinite(animation.iterations))).toEqual([])
        expect(animations.filter((animation) => animation.playState === 'running')).toEqual([])
      })
    }
  })

  test(`${option.title} fades out on Finish loading and comes back on Show again`, async ({
    optionsPage,
  }) => {
    await optionsPage.goto(optionPath(option.slug))

    await optionsPage.finishLoading.click()
    await expect(optionsPage.loadingScreens).toHaveCount(0)

    await optionsPage.showAgain.click()
    await expect(optionsPage.loadingScreens).toHaveCount(2)
  })
}

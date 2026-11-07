import type { Locator } from '@playwright/test'
import { administratorState, expect, test } from './fixtures.ts'

test.use({ storageState: administratorState, viewport: { width: 390, height: 844 } })

test('a game stuck offline is the grey offline slot, with no amber', async ({ page, context }) => {
  await page.goto('/matches/demo/scores/game/1/edit')
  const strip = page.getByRole('navigation', { name: 'Games' })
  const slot = (game: number) => strip.locator('.score-slot', { hasText: `Game ${game}` })
  const style = (locator: Locator, property: string) =>
    locator.evaluate(
      (element, property) => element.ownerDocument.defaultView!.getComputedStyle(element).getPropertyValue(property),
      property,
    )

  const inputs = page.getByRole('textbox')
  // The dev server serves the page's modules one by one, so it goes
  // offline only once they have all loaded.
  await expect(inputs).toHaveCount(2)
  await context.setOffline(true)
  await inputs.nth(0).fill('11')
  await inputs.nth(1).fill('7')
  await page.getByRole('button', { name: 'Save game 1' }).click()

  const note = strip.getByRole('status')
  await expect(note).toHaveText('Offline. Saved on this device.')
  await expect(slot(1)).toHaveCSS('border-top-style', 'dashed')
  // Game 1 was the current game, so its accent edge fades out first.
  const usualBorder = await style(slot(3), 'border-top-color')
  await expect(slot(1), 'the stuck edge keeps the usual border colour').toHaveCSS('border-top-color', usualBorder)
  const labelGrey = await style(strip.getByText('Games', { exact: true }), 'color')
  await expect(note, 'the note is the Games label’s grey').toHaveCSS('color', labelGrey)
  await test.info().attach('offline strip', { body: await strip.screenshot(), contentType: 'image/png' })

  await context.setOffline(false)
  await expect(slot(1)).toHaveCSS('border-top-style', 'solid')
})

import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { noNewVersion } from '../DeviceAlert.page.tsx'
import { MatchUnavailableScreenPage } from './MatchUnavailableScreen.page.tsx'

// The screen alone, with the props it takes. That a match's pages show it
// when the device won't read the match is the route's test
// (src/routes/matches/$matchId.test.tsx).

test('a match the device wouldn’t read says it can’t be opened and why, with a link to all matches', async () => {
  const page = new MatchUnavailableScreenPage()
  page.render({ reason: 'storage-unavailable', newVersion: noNewVersion, onRetry: async () => {} })

  expect(await page.heading()).toBeVisible()
  expect(await page.alert()).toHaveTextContent(
    'This browser isn’t letting FortyMM read its data.',
  )
  expect(await page.allMatches()).toHaveAttribute('href', '/matches')
})

test('Try again reads the match again; refused again, the alert is shown anew', async () => {
  const user = userEvent.setup()
  let release = () => {}
  const onRetry = vi.fn(() => new Promise<void>((resolve) => (release = resolve)))
  const page = new MatchUnavailableScreenPage()
  page.render({ reason: 'core-unavailable', newVersion: noNewVersion, onRetry })
  const before = await page.alert()

  await user.click(await page.tryAgain())

  expect(onRetry).toHaveBeenCalledTimes(1)
  expect(page.alertNow()).toBe(before)
  release()
  await vi.waitFor(() => expect(page.alertNow()).not.toBe(before))
  expect(page.alertNow()).toHaveTextContent('Try again.')
  // The pressed button was remounted with its alert: focus is on the new one.
  expect(await page.tryAgain()).toHaveFocus()
})

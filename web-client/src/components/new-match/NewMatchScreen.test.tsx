import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import type { Failure } from '../../stores/match-source.ts'
import { NewMatchScreenPage } from './NewMatchScreen.page.tsx'

test('the new match screen has its heading, the match length, and Cancel back to the dashboard', async () => {
  const page = new NewMatchScreenPage()
  page.render({ onSubmit: vi.fn(kept) })

  expect(await page.heading()).toBeVisible()
  expect(await page.bestOf(5)).toBeChecked()
  expect(await page.cancel()).toHaveAttribute('href', '/')
})

test('the form asks no opponent’s name and has no rated control', async () => {
  const page = new NewMatchScreenPage()
  page.render({ onSubmit: vi.fn(kept) })

  expect(await page.textboxes()).toEqual([])
  expect(await page.toggles()).toEqual([])
})

test('nothing on the form speaks of a name or of rating a match', async () => {
  const page = new NewMatchScreenPage()
  page.render({ onSubmit: vi.fn(kept) })

  const text = (await page.form()).textContent
  expect(text).not.toMatch(/name/i)
  // "Unrated" is the one word of rating it may say.
  expect(text).not.toMatch(/\brat(ed|ing|e)\b/i)
})

test('Start match on a form left as it opens hands an unrated best of 5', async () => {
  const user = userEvent.setup()
  const onSubmit = vi.fn(kept)
  const page = new NewMatchScreenPage()
  page.render({ onSubmit })

  await user.click(await page.startMatch())

  expect(onSubmit).toHaveBeenCalledTimes(1)
  expect(onSubmit).toHaveBeenCalledWith({ format: { bestOf: 5 }, rated: false })
})

test('Start match hands the length chosen, unrated', async () => {
  const user = userEvent.setup()
  const onSubmit = vi.fn(kept)
  const page = new NewMatchScreenPage()
  page.render({ onSubmit })

  await user.click(await page.bestOf(3))
  await user.click(await page.startMatch())

  expect(onSubmit).toHaveBeenCalledTimes(1)
  expect(onSubmit).toHaveBeenCalledWith({ format: { bestOf: 3 }, rated: false })
})

test('the summary says who plays, You vs Anonymous, the length chosen, and Unrated', async () => {
  const user = userEvent.setup()
  const page = new NewMatchScreenPage()
  page.render({ onSubmit: vi.fn(kept) })
  expect(await page.summary()).toHaveTextContent('Ready: You vs Anonymous')
  expect(await page.summaryDetails()).toHaveTextContent(
    'Best of 5 · first to 3 · Unrated · games to 11, win by 2',
  )

  await user.click(await page.bestOf(1))

  expect(await page.summaryDetails()).toHaveTextContent(
    'Single game · Unrated · games to 11, win by 2',
  )
})

test('Cancel on a form left as it opened leaves with no question', async () => {
  const user = userEvent.setup()
  const page = new NewMatchScreenPage()
  page.render({ onSubmit: vi.fn(kept) })

  await user.click(await page.cancel())

  expect(page.queryDiscardDialog()).toBeNull()
})

test('Cancel on a form changed and changed back to how it opened leaves with no question', async () => {
  const user = userEvent.setup()
  const page = new NewMatchScreenPage()
  page.render({ onSubmit: vi.fn(kept) })
  await user.click(await page.bestOf(7))

  await user.click(await page.bestOf(5))
  await user.click(await page.cancel())

  expect(page.queryDiscardDialog()).toBeNull()
})

test('Cancel with the length changed asks “Discard changes?”, its focus on Keep editing', async () => {
  const user = userEvent.setup()
  const page = new NewMatchScreenPage()
  page.render({ onSubmit: vi.fn(kept) })
  await user.click(await page.bestOf(7))

  await user.click(await page.cancel())

  expect(await page.discardDialog()).toBeVisible()
  expect(await page.keepEditing()).toHaveFocus()
})

test('Keep editing, or Escape, closes the question and keeps what was chosen', async () => {
  const user = userEvent.setup()
  const page = new NewMatchScreenPage()
  page.render({ onSubmit: vi.fn(kept) })
  await user.click(await page.bestOf(7))

  await user.click(await page.cancel())
  await user.click(await page.keepEditing())
  expect(page.queryDiscardDialog()).toBeNull()

  await user.click(await page.cancel())
  await page.discardDialog()
  await user.keyboard('{Escape}')
  expect(page.queryDiscardDialog()).toBeNull()

  expect(await page.bestOf(7)).toBeChecked()
})

test('a Start match the device refused says it couldn’t start the match and what to do, and the form stays as chosen', async () => {
  const user = userEvent.setup()
  const page = new NewMatchScreenPage()
  page.render({ onSubmit: vi.fn(refused('storage-unavailable')) })

  await user.click(await page.bestOf(7))
  await user.click(await page.startMatch())

  const alert = await page.alert()
  expect(alert).toHaveAccessibleName('Couldn’t start the match')
  expect(alert).toHaveTextContent('Check that your browser allows site data and that you have free storage space, then try again.')
  expect(await page.bestOf(7)).toBeChecked()
})

test('the next Start match takes the alert away when pressed; one that works leaves none', async () => {
  const user = userEvent.setup()
  let release = () => {}
  const onSubmit = vi
    .fn<Parameters<typeof page.render>[0]['onSubmit']>()
    .mockImplementationOnce(refused('locks-unavailable'))
    // The second answer waits, to see the alert gone while it does.
    .mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => (release = resolve))
      return { ok: true }
    })
  const page = new NewMatchScreenPage()
  page.render({ onSubmit })
  await user.click(await page.startMatch())
  await page.alert()

  await user.click(await page.startMatch())

  expect(page.queryAlert()).toBeNull()
  release()
  await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2))
  expect(page.queryAlert()).toBeNull()
})

// An alert whose node stays, its words unchanged, is not read out again.
test('a Start match refused again, at once, shows the alert anew: a new alert in place of the old', async () => {
  const user = userEvent.setup()
  const page = new NewMatchScreenPage()
  page.render({ onSubmit: vi.fn(refused('storage-unavailable')) })
  await user.click(await page.startMatch())
  const first = await page.alert()

  await user.click(await page.startMatch())

  await vi.waitFor(() => expect(page.queryAlert()).not.toBe(first))
  expect(page.queryAlert()).toHaveTextContent('Couldn’t start the match')
})

test('with a new version waiting, a Start match refused for the core offers Reload, which switches to it without asking to leave', async () => {
  const user = userEvent.setup()
  const reload = vi.fn()
  const page = new NewMatchScreenPage()
  page.render(
    { onSubmit: vi.fn(refused('core-unavailable')), newVersion: { waiting: true, reload } },
    { browserHistory: true },
  )
  await user.click(await page.bestOf(7))
  await user.click(await page.startMatch())
  expect(await page.alert()).toHaveTextContent(
    'Reload FortyMM, then start the match again. Your unsaved changes will be lost.',
  )
  // The changed form asks the browser before the page goes...
  expect(unloadAsks()).toBe(true)

  await user.click(await page.reload())

  expect(reload).toHaveBeenCalledTimes(1)
  // ...but not for the reload the person asked for.
  expect(unloadAsks()).toBe(false)
})

// What the device refused, as the store answers it.
function refused(reason: Failure['reason']) {
  return async () => ({ ok: false as const, reason })
}

// A kept match, as the store answers it.
async function kept() {
  return { ok: true as const }
}

// Whether the browser would ask before the page goes (the leave guard's
// beforeunload handler cancels the event).
function unloadAsks() {
  const event = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(event)
  return event.defaultPrevented
}

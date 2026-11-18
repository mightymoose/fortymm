import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { DeviceAlert, type DeviceRefusal } from './DeviceAlert.tsx'
import { findAlert, noNewVersion } from './DeviceAlert.page.tsx'

// The words for each refusal of this device's storage, as the user approved
// them (2026-11-17), and what the alert offers. Each screen proves it shows
// this alert for one refusal; the words for every refusal are proven here.

const storage =
  'Check that your browser allows site data and that you have free storage space, then try again.'
const unsupported = {
  title: 'Your browser doesn’t support saving matches',
  body: 'Update your browser or try another browser.',
}

test.each<{ refusal: DeviceRefusal; title: string; body: string }>([
  { refusal: { action: 'start', reason: 'storage-unavailable' }, title: 'Couldn’t start the match', body: storage },
  { refusal: { action: 'save', reason: 'storage-unavailable' }, title: 'Couldn’t save your score', body: storage },
  { refusal: { action: 'clear', reason: 'storage-unavailable' }, title: 'Couldn’t clear your score', body: storage },
  { refusal: { action: 'start', reason: 'signing-unavailable' }, ...unsupported },
  { refusal: { action: 'save', reason: 'locks-unavailable' }, ...unsupported },
  { refusal: { action: 'clear', reason: 'signing-unavailable' }, ...unsupported },
  {
    refusal: { action: 'start', reason: 'core-unavailable' },
    title: 'Couldn’t start the match',
    body: 'Part of FortyMM didn’t load. Try starting the match again.',
  },
  {
    refusal: { action: 'save', reason: 'core-unavailable' },
    title: 'Couldn’t save your score',
    body: 'Part of FortyMM didn’t load. Try saving again.',
  },
  {
    refusal: { action: 'clear', reason: 'core-unavailable' },
    title: 'Couldn’t clear your score',
    body: 'Part of FortyMM didn’t load. Try clearing it again.',
  },
])('$refusal.action refused for $refusal.reason: “$title”, “$body”, no button', async ({ refusal, title, body }) => {
  render(<DeviceAlert refusal={refusal} newVersion={noNewVersion} />)

  const alert = await findAlert()
  expect(alert).toHaveAccessibleName(title)
  expect(alert).toHaveTextContent(`${title}${body}`)
  expect(screen.queryByRole('button')).toBeNull()
})

test.each<{ reason: 'storage-unavailable' | 'core-unavailable'; body: string }>([
  { reason: 'storage-unavailable', body: '' },
  { reason: 'core-unavailable', body: 'Part of FortyMM didn’t load. Try again.' },
])('a read refused for $reason: its title, “$body”, and Try again, which calls onRetry', async ({ reason, body }) => {
  const user = userEvent.setup()
  const onRetry = vi.fn()
  render(
    <DeviceAlert
      title="Couldn’t load your matches"
      refusal={{ action: 'read', reason }}
      newVersion={noNewVersion}
      onRetry={onRetry}
    />,
  )

  const alert = await findAlert()
  expect(alert).toHaveAccessibleName('Couldn’t load your matches')
  expect(alert).toHaveTextContent(`Couldn’t load your matches${body}Try again`, { normalizeWhitespace: true })
  await user.click(screen.getByRole('button', { name: 'Try again' }))
  expect(onRetry).toHaveBeenCalledTimes(1)
})

test('a refused correction says first that the saved score is still saved', async () => {
  render(
    <DeviceAlert
      refusal={{ action: 'save', reason: 'storage-unavailable' }}
      newVersion={noNewVersion}
      saved="11–7"
    />,
  )

  expect(await findAlert()).toHaveTextContent(`Your saved score is still 11–7. ${storage}`)
})

test.each<{ refusal: DeviceRefusal; unsaved: boolean; body: string }>([
  {
    refusal: { action: 'save', reason: 'core-unavailable' },
    unsaved: true,
    body: 'Reload FortyMM, then enter your score again. Your unsaved changes will be lost.',
  },
  {
    refusal: { action: 'save', reason: 'core-unavailable' },
    unsaved: false,
    body: 'Reload FortyMM, then enter your score again.',
  },
  {
    refusal: { action: 'start', reason: 'core-unavailable' },
    unsaved: false,
    body: 'Reload FortyMM, then start the match again.',
  },
  {
    refusal: { action: 'clear', reason: 'core-unavailable' },
    unsaved: false,
    body: 'Reload FortyMM, then clear your score again.',
  },
  { refusal: { action: 'read', reason: 'core-unavailable' }, unsaved: false, body: 'Reload FortyMM, then try again.' },
])(
  'with a new version waiting, a $refusal.action refused for the core says “$body”, and Reload, in Try again’s place, switches to it',
  async ({ refusal, unsaved, body }) => {
    const user = userEvent.setup()
    const reload = vi.fn()
    const onReload = vi.fn()
    render(
      <DeviceAlert
        title="Couldn’t load your matches"
        refusal={refusal}
        newVersion={{ waiting: true, reload }}
        unsaved={unsaved}
        onReload={onReload}
        onRetry={() => {}}
      />,
    )

    const alert = await findAlert()
    expect(alert).toHaveTextContent(body)
    if (!unsaved) expect(alert).not.toHaveTextContent('unsaved')
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Reload' }))
    expect(onReload).toHaveBeenCalledTimes(1)
    expect(reload).toHaveBeenCalledTimes(1)
  },
)

test('a new version waiting changes nothing for a refusal that isn’t the core’s', async () => {
  render(
    <DeviceAlert
      refusal={{ action: 'save', reason: 'storage-unavailable' }}
      newVersion={{ waiting: true, reload: () => {} }}
    />,
  )

  expect(await findAlert()).toHaveTextContent(storage)
  expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull()
})

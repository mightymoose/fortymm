import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { DeviceAlert, type DeviceRefusal } from './DeviceAlert.tsx'
import { findAlert, noNewVersion } from './DeviceAlert.page.tsx'

// The words for each refusal of this device's storage, as the user approved
// them (2026-11-16), and what the alert offers. Each screen proves it shows
// this alert for one refusal; the words for every refusal are proven here.

const plotTwist =
  'Plot twist: a new FortyMM arrived mid-match. Reload to switch to it, then try again.'

test.each<{ refusal: DeviceRefusal; body: string }>([
  {
    refusal: { action: 'write', reason: 'storage-unavailable' },
    body: 'This browser isn’t letting FortyMM store data.',
  },
  {
    refusal: { action: 'write', reason: 'locks-unavailable' },
    body: 'This browser isn’t letting FortyMM store data.',
  },
  {
    refusal: { action: 'write', reason: 'signing-unavailable' },
    body: 'This browser isn’t letting FortyMM sign it.',
  },
  { refusal: { action: 'write', reason: 'core-unavailable' }, body: 'Try again.' },
  {
    refusal: { action: 'read', reason: 'storage-unavailable' },
    body: 'This browser isn’t letting FortyMM read its data.',
  },
  { refusal: { action: 'read', reason: 'core-unavailable' }, body: 'Try again.' },
])('a $refusal.action the device refused for $refusal.reason says “$body”, with no Reload', async ({ refusal, body }) => {
  render(<DeviceAlert title="That wasn’t saved." refusal={refusal} newVersion={noNewVersion} />)

  const alert = await findAlert()
  expect(alert).toHaveTextContent('That wasn’t saved.')
  expect(alert).toHaveTextContent(body)
  expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull()
})

test.each<DeviceRefusal['action']>(['write', 'read'])(
  'with a new version waiting, a %s refused for the core says the app was updated, and Reload switches to it',
  async (action) => {
    const user = userEvent.setup()
    const reload = vi.fn()
    const onReload = vi.fn()
    render(
      <DeviceAlert
        title="That wasn’t saved."
        refusal={{ action, reason: 'core-unavailable' }}
        newVersion={{ waiting: true, reload }}
        lost="Reloading clears 11–7; you’ll type it again."
        onReload={onReload}
        onRetry={() => {}}
      />,
    )

    expect(await findAlert()).toHaveTextContent(
      `${plotTwist} Reloading clears 11–7; you’ll type it again.`,
    )
    // Reload takes Try again's place.
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Reload' }))
    expect(onReload).toHaveBeenCalledTimes(1)
    expect(reload).toHaveBeenCalledTimes(1)
  },
)

test('a new version waiting changes nothing for a refusal that isn’t the core’s', async () => {
  render(
    <DeviceAlert
      title="That wasn’t saved."
      refusal={{ action: 'write', reason: 'storage-unavailable' }}
      newVersion={{ waiting: true, reload: () => {} }}
    />,
  )

  expect(await findAlert()).not.toHaveTextContent('Plot twist')
  expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull()
})

test('given onRetry, Try again calls it', async () => {
  const user = userEvent.setup()
  const onRetry = vi.fn()
  render(
    <DeviceAlert
      title="Your matches can’t be shown."
      refusal={{ action: 'read', reason: 'storage-unavailable' }}
      newVersion={noNewVersion}
      onRetry={onRetry}
    />,
  )

  await user.click(await screen.findByRole('button', { name: 'Try again' }))
  expect(onRetry).toHaveBeenCalledTimes(1)
})

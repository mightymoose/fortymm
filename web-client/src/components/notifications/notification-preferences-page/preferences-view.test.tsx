import type { NotificationChannel } from '@/api/notifications'
import { notificationPreferences } from '@/test/factories'
import { preferencesViewPage } from './preferences-view.page'

/** Flip one channel's `setup_required` to surface (or clear) its nudge. */
function withSetupRequired(channel: NotificationChannel, value: boolean) {
  const base = notificationPreferences()
  return {
    ...base,
    channels: base.channels.map((c) =>
      c.channel === channel ? { ...c, setup_required: value } : c,
    ),
  }
}

describe('PreferencesView', () => {
  it('renders the settings heading', async () => {
    preferencesViewPage.render()
    expect(await preferencesViewPage.findHeading()).toBeInTheDocument()
  })

  it('locks the in-app channel on', async () => {
    preferencesViewPage.render()
    await preferencesViewPage.findHeading()
    const inApp = preferencesViewPage.channelSwitch('In-app')
    expect(inApp).toBeChecked()
    expect(inApp).toBeDisabled()
  })

  it('disables the unavailable SMS channel', async () => {
    preferencesViewPage.render()
    await preferencesViewPage.findHeading()
    const sms = preferencesViewPage.channelSwitch('SMS')
    expect(sms).not.toBeChecked()
    expect(sms).toBeDisabled()
  })

  it('shows each channel destination', async () => {
    preferencesViewPage.render()
    await preferencesViewPage.findHeading()
    expect(preferencesViewPage.queryText('you@fortymm.club')).toBeInTheDocument()
  })

  it('toggles a channel master', async () => {
    const onToggleChannel = vi.fn()
    preferencesViewPage.render({ onToggleChannel })
    await preferencesViewPage.findHeading()
    // Push starts on, so a click turns it off.
    await preferencesViewPage.toggleChannel('Push')
    expect(onToggleChannel).toHaveBeenCalledWith('push', false)
  })

  it('locks the match-reminder in-app cell on', async () => {
    preferencesViewPage.render()
    await preferencesViewPage.findHeading()
    const cell = preferencesViewPage.cell('Match reminders', 'In-app')
    expect(cell).toBeChecked()
    expect(cell).toBeDisabled()
  })

  it('toggles a matrix cell', async () => {
    const onToggleCell = vi.fn()
    preferencesViewPage.render({ onToggleCell })
    await preferencesViewPage.findHeading()
    // Rating-change email starts on; clicking mutes it.
    await preferencesViewPage.toggleCell('Rating changes', 'Email')
    expect(onToggleCell).toHaveBeenCalledWith('rating_change', 'email', false)
  })

  it('greys out a column whose channel master is off', async () => {
    const base = notificationPreferences()
    const pushOff = {
      ...base,
      channels: base.channels.map((c) =>
        c.channel === 'push' ? { ...c, enabled: false } : c,
      ),
    }
    preferencesViewPage.render({ preferences: pushOff })
    await preferencesViewPage.findHeading()
    // The cell keeps its own checked state but can't be toggled while muted.
    expect(preferencesViewPage.cell('Rating changes', 'Push')).toBeDisabled()
  })

  it('nudges to add an email when the email channel needs setup', async () => {
    preferencesViewPage.render({ preferences: withSetupRequired('email', true) })
    await preferencesViewPage.findHeading()
    const cta = preferencesViewPage.nudgeCta('Add email')
    expect(cta).toHaveAttribute('href', '/settings#sec-email')
  })

  it('switches to a confirm-email nudge when an address is pending', async () => {
    preferencesViewPage.render({
      preferences: withSetupRequired('email', true),
      pendingEmail: 'quinn@example.com',
    })
    await preferencesViewPage.findHeading()
    // The pending variant replaces "Add email" and the card subtitle reflects
    // the unconfirmed address instead of "Add an email in settings".
    expect(preferencesViewPage.nudgeCta('Manage email')).toHaveAttribute(
      'href',
      '/settings#sec-email',
    )
    expect(preferencesViewPage.queryNudgeCta('Add email')).not.toBeInTheDocument()
    expect(
      preferencesViewPage.queryText('Pending — check your inbox'),
    ).toBeInTheDocument()
  })

  it('nudges to set up push when no devices are registered', async () => {
    preferencesViewPage.render({ preferences: withSetupRequired('push', true) })
    await preferencesViewPage.findHeading()
    const cta = preferencesViewPage.nudgeCta('Set up push')
    expect(cta).toHaveAttribute('href', '/settings#sec-notifications')
  })

  it('shows no nudge for an unavailable channel even if setup is required', async () => {
    const base = notificationPreferences()
    // A channel the server can't deliver on (available: false) shouldn't nudge —
    // there's nothing the user can do — even if setup_required slips through.
    const unavailable = {
      ...base,
      channels: base.channels.map((c) =>
        c.channel === 'push'
          ? { ...c, available: false, setup_required: true }
          : c,
      ),
    }
    preferencesViewPage.render({ preferences: unavailable })
    await preferencesViewPage.findHeading()
    expect(
      preferencesViewPage.queryNudgeCta('Set up push'),
    ).not.toBeInTheDocument()
  })

  it('shows no setup nudge for a fully configured account', async () => {
    preferencesViewPage.render()
    await preferencesViewPage.findHeading()
    expect(preferencesViewPage.queryNudgeCta('Add email')).not.toBeInTheDocument()
    expect(
      preferencesViewPage.queryNudgeCta('Set up push'),
    ).not.toBeInTheDocument()
  })
})

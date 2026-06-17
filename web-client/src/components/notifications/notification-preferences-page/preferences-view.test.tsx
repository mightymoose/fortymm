import { notificationPreferences } from '@/test/factories'
import { preferencesViewPage } from './preferences-view.page'

describe('PreferencesView', () => {
  it('renders the settings heading', () => {
    preferencesViewPage.render()
    expect(preferencesViewPage.getHeading()).toBeInTheDocument()
  })

  it('locks the in-app channel on', () => {
    preferencesViewPage.render()
    const inApp = preferencesViewPage.channelSwitch('In-app')
    expect(inApp).toBeChecked()
    expect(inApp).toBeDisabled()
  })

  it('disables the unavailable SMS channel', () => {
    preferencesViewPage.render()
    const sms = preferencesViewPage.channelSwitch('SMS')
    expect(sms).not.toBeChecked()
    expect(sms).toBeDisabled()
  })

  it('shows each channel destination', () => {
    preferencesViewPage.render()
    expect(preferencesViewPage.queryText('you@fortymm.club')).toBeInTheDocument()
  })

  it('toggles a channel master', async () => {
    const onToggleChannel = vi.fn()
    preferencesViewPage.render({ onToggleChannel })
    // Push starts on, so a click turns it off.
    await preferencesViewPage.toggleChannel('Push')
    expect(onToggleChannel).toHaveBeenCalledWith('push', false)
  })

  it('locks the match-reminder in-app cell on', () => {
    preferencesViewPage.render()
    const cell = preferencesViewPage.cell('Match reminders', 'In-app')
    expect(cell).toBeChecked()
    expect(cell).toBeDisabled()
  })

  it('toggles a matrix cell', async () => {
    const onToggleCell = vi.fn()
    preferencesViewPage.render({ onToggleCell })
    // Rating-change email starts on; clicking mutes it.
    await preferencesViewPage.toggleCell('Rating changes', 'Email')
    expect(onToggleCell).toHaveBeenCalledWith('rating_change', 'email', false)
  })

  it('greys out a column whose channel master is off', () => {
    const base = notificationPreferences()
    const pushOff = {
      ...base,
      channels: base.channels.map((c) =>
        c.channel === 'push' ? { ...c, enabled: false } : c,
      ),
    }
    preferencesViewPage.render({ preferences: pushOff })
    // The cell keeps its own checked state but can't be toggled while muted.
    expect(preferencesViewPage.cell('Rating changes', 'Push')).toBeDisabled()
  })
})

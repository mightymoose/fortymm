import { broadcastViewPage } from './broadcast-view.page'

describe('BroadcastView', () => {
  it('lists the recipients', () => {
    broadcastViewPage.render()
    expect(broadcastViewPage.getRecipient('nguyen.t')).toBeInTheDocument()
    expect(broadcastViewPage.getRecipient('okafor.d')).toBeInTheDocument()
  })

  it('toggles the send-to-all audience', async () => {
    const onAudienceAllChange = vi.fn()
    broadcastViewPage.render({ onAudienceAllChange })
    await broadcastViewPage.clickSelectAll()
    expect(onAudienceAllChange).toHaveBeenCalledWith(true)
  })

  it('checks and disables individual recipients when audience is "all"', () => {
    broadcastViewPage.render({ audience: 'all' })
    const recipient = broadcastViewPage.getRecipient('nguyen.t')
    expect(recipient).toBeChecked()
    expect(recipient).toBeDisabled()
  })

  it('reflects picked recipients and fires a toggle', async () => {
    const onToggleRecipient = vi.fn()
    broadcastViewPage.render({
      selectedIds: new Set(['u-1']),
      onToggleRecipient,
    })
    expect(broadcastViewPage.getRecipient('nguyen.t')).toBeChecked()
    expect(broadcastViewPage.getRecipient('okafor.d')).not.toBeChecked()
    await broadcastViewPage.clickRecipient('okafor.d')
    expect(onToggleRecipient).toHaveBeenCalledWith('u-2')
  })

  it('marks selected channels pressed and toggles them', async () => {
    const onToggleChannel = vi.fn()
    broadcastViewPage.render({ channels: new Set(['in_app']), onToggleChannel })
    expect(broadcastViewPage.getChannelChip('In-app')).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(broadcastViewPage.getChannelChip('Email')).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    await broadcastViewPage.clickChannel('Email')
    expect(onToggleChannel).toHaveBeenCalledWith('email')
  })

  it('disables send until the draft is valid', () => {
    broadcastViewPage.render({ canSend: false })
    expect(broadcastViewPage.getSendButton()).toBeDisabled()
  })

  it('sends when valid', async () => {
    const onSend = vi.fn()
    broadcastViewPage.render({ canSend: true, selectedCount: 3, onSend })
    expect(broadcastViewPage.getSendButton()).toHaveTextContent('Send to 3 players')
    await broadcastViewPage.clickSend()
    expect(onSend).toHaveBeenCalledTimes(1)
  })

  it('shows a success summary with the returned counts', () => {
    broadcastViewPage.render({
      result: { recipients: 7, in_app_created: 7, pushed: 4, emailed: 2 },
    })
    expect(broadcastViewPage.querySuccess()).toHaveTextContent('Sent to 7 players')
    expect(
      broadcastViewPage.queryHint('In-app 7 · push 4 · email 2'),
    ).toBeInTheDocument()
  })

  it('shows an error alert on a failed send', () => {
    broadcastViewPage.render({ error: 'Forbidden.' })
    expect(broadcastViewPage.queryError()).toBeInTheDocument()
    expect(broadcastViewPage.queryHint('Forbidden.')).toBeInTheDocument()
    expect(broadcastViewPage.querySuccess()).not.toBeInTheDocument()
  })

  it('hints the next missing precondition', () => {
    broadcastViewPage.render({ canSend: false, selectedCount: 0 })
    expect(
      broadcastViewPage.queryHint('Pick at least one recipient.'),
    ).toBeInTheDocument()

    broadcastViewPage.render({
      canSend: false,
      selectedCount: 2,
      channels: new Set(),
    })
    expect(
      broadcastViewPage.queryHint('Pick at least one channel.'),
    ).toBeInTheDocument()
  })

  it('previews only the selected channels', () => {
    broadcastViewPage.render({ channels: new Set(['email']) })
    expect(broadcastViewPage.queryPreviewSection('EMAIL')).toBeInTheDocument()
    expect(broadcastViewPage.queryPreviewSection('IN-APP / BELL')).not.toBeInTheDocument()
    expect(broadcastViewPage.queryPreviewSection('PUSH')).not.toBeInTheDocument()
  })

  it('previews in-app and push by default', () => {
    broadcastViewPage.render()
    expect(broadcastViewPage.queryPreviewSection('IN-APP / BELL')).toBeInTheDocument()
    expect(broadcastViewPage.queryPreviewSection('PUSH')).toBeInTheDocument()
  })
})

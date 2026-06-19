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

  it('shows a queued summary with the recipient count', () => {
    broadcastViewPage.render({ result: { recipients: 7, queued: true } })
    expect(broadcastViewPage.querySuccess()).toHaveTextContent(
      'Queued for 7 players',
    )
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

    broadcastViewPage.render({ canSend: false, selectedCount: 2 })
    expect(broadcastViewPage.queryHint('Add a title.')).toBeInTheDocument()
  })

  it('surfaces an error in the recipient list when the search fails', () => {
    broadcastViewPage.render({
      recipients: [],
      recipientTotal: 0,
      recipientsError: true,
      search: 'riko',
    })
    expect(broadcastViewPage.queryRecipientsError()).toBeInTheDocument()
    // The error must not read as a misleading "no players" empty state.
    expect(broadcastViewPage.queryNoMatch()).not.toBeInTheDocument()
  })

  it('previews the in-app notification', () => {
    broadcastViewPage.render()
    expect(
      broadcastViewPage.queryPreviewSection('IN-APP / BELL'),
    ).toBeInTheDocument()
  })

  it('shows the selected category on the trigger', () => {
    broadcastViewPage.render({ category: 'rating_change' })
    expect(broadcastViewPage.getCategoryTrigger()).toHaveTextContent(
      'Rating change',
    )
  })

  it('files the message under the selected category', () => {
    broadcastViewPage.render({ category: 'rating_change' })
    expect(
      broadcastViewPage.queryFiledUnder('Rating change'),
    ).toBeInTheDocument()
  })
})

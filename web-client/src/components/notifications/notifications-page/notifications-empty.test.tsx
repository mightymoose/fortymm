import { notificationsEmptyPage } from './notifications-empty.page'

describe('NotificationsEmpty', () => {
  describe('with an empty inbox', () => {
    it('offers a way back into the product (#901)', async () => {
      notificationsEmptyPage.render({ state: { kind: 'inbox-empty' } })
      await notificationsEmptyPage.findHeadline()

      expect(notificationsEmptyPage.queryLogMatchLink()).toHaveAttribute(
        'href',
        '/matches/new',
      )
      expect(notificationsEmptyPage.queryPreferencesLink()).toHaveAttribute(
        'href',
        '/notifications/settings',
      )
    })

    it('does not offer to clear a filter that is not applied', async () => {
      notificationsEmptyPage.render({ state: { kind: 'inbox-empty' } })
      await notificationsEmptyPage.findHeadline()

      expect(notificationsEmptyPage.queryShowAll()).not.toBeInTheDocument()
    })
  })

  describe('with a filter matching nothing', () => {
    const filterEmpty = (onShowAll = () => {}) =>
      ({ kind: 'filter-empty', filterLabel: 'Unread', onShowAll }) as const

    it('names the filter rather than telling a user with notifications to go play', async () => {
      notificationsEmptyPage.render({ state: filterEmpty() })
      await notificationsEmptyPage.findFilterCopy('Unread')

      expect(notificationsEmptyPage.queryGoPlayCopy()).not.toBeInTheDocument()
    })

    // The user's notifications are still sitting there, one pill away — claiming
    // they're "all caught up" contradicts the very line beneath it (QA, #901).
    it('does not borrow the empty inbox\'s "All caught up." reassurance', async () => {
      notificationsEmptyPage.render({ state: filterEmpty() })
      await notificationsEmptyPage.findFilterCopy('Unread')

      expect(notificationsEmptyPage.queryHeadline()).not.toBeInTheDocument()
    })

    it('offers to clear the filter instead of starting a match', async () => {
      notificationsEmptyPage.render({ state: filterEmpty() })
      await notificationsEmptyPage.findFilterCopy('Unread')

      expect(notificationsEmptyPage.queryShowAll()).toBeInTheDocument()
      expect(notificationsEmptyPage.queryLogMatchLink()).not.toBeInTheDocument()
    })

    it('clears the filter when "Show all" is clicked', async () => {
      const onShowAll = vi.fn()
      notificationsEmptyPage.render({ state: filterEmpty(onShowAll) })
      await notificationsEmptyPage.findFilterCopy('Unread')

      await notificationsEmptyPage.clickShowAll()
      expect(onShowAll).toHaveBeenCalledTimes(1)
    })
  })
})

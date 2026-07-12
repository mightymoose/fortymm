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
    const filtered = { kind: 'filter-empty', filterLabel: 'Unread' } as const

    it('names the filter rather than telling a user with notifications to go play', async () => {
      notificationsEmptyPage.render({ state: filtered })
      await notificationsEmptyPage.findHeadline()

      expect(
        notificationsEmptyPage.querySubcopy('Nothing under Unread.'),
      ).toBeInTheDocument()
      expect(
        notificationsEmptyPage.querySubcopy('Nothing here. Go play.'),
      ).not.toBeInTheDocument()
    })

    it('offers to clear the filter instead of starting a match', async () => {
      notificationsEmptyPage.render({ state: filtered })
      await notificationsEmptyPage.findHeadline()

      expect(notificationsEmptyPage.queryShowAll()).toBeInTheDocument()
      expect(notificationsEmptyPage.queryLogMatchLink()).not.toBeInTheDocument()
    })

    it('clears the filter when "Show all" is clicked', async () => {
      const onShowAll = vi.fn()
      notificationsEmptyPage.render({ state: filtered, onShowAll })
      await notificationsEmptyPage.findHeadline()

      await notificationsEmptyPage.clickShowAll()
      expect(onShowAll).toHaveBeenCalledTimes(1)
    })
  })
})

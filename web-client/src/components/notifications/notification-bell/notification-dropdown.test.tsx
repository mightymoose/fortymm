import { buildNotificationItem } from '../notification-row.factory'
import { buildDropdownItems } from './notification-dropdown.factory'
import { notificationDropdownPage } from './notification-dropdown.page'

describe('NotificationDropdown', () => {
  it('lists the notifications', () => {
    notificationDropdownPage.render()
    expect(notificationDropdownPage.queryTitle('Accept your score')).toBeInTheDocument()
    expect(notificationDropdownPage.queryTitle('Rating +12')).toBeInTheDocument()
  })

  it('shows the unread count and a mark-all-read control when unread', () => {
    notificationDropdownPage.render({ unreadCount: 3 })
    expect(notificationDropdownPage.queryNewBadge()).toHaveTextContent('3 new')
    expect(notificationDropdownPage.queryMarkAllRead()).toBeInTheDocument()
  })

  it('hides the count and mark-all-read when nothing is unread', () => {
    notificationDropdownPage.render({ unreadCount: 0 })
    expect(notificationDropdownPage.queryNewBadge()).not.toBeInTheDocument()
    expect(notificationDropdownPage.queryMarkAllRead()).not.toBeInTheDocument()
  })

  it('shows the empty state with no items', () => {
    notificationDropdownPage.render({ items: [], unreadCount: 0 })
    expect(notificationDropdownPage.queryEmptyState()).toBeInTheDocument()
  })

  it('shows a loading state', () => {
    notificationDropdownPage.render({ items: [], isLoading: true })
    expect(notificationDropdownPage.queryLoading()).toBeInTheDocument()
    expect(notificationDropdownPage.queryEmptyState()).not.toBeInTheDocument()
  })

  it('shows an error state instead of "all caught up" on a failed fetch', () => {
    notificationDropdownPage.render({ items: [], isError: true })
    expect(notificationDropdownPage.queryError()).toBeInTheDocument()
    expect(notificationDropdownPage.queryEmptyState()).not.toBeInTheDocument()
  })

  it('caps the dropdown at six rows', () => {
    const items = Array.from({ length: 8 }, (_, i) =>
      buildNotificationItem({ id: `n-${i}`, title: `Notification ${i}` }),
    )
    notificationDropdownPage.render({ items })
    expect(notificationDropdownPage.queryTitle('Notification 5')).toBeInTheDocument()
    expect(notificationDropdownPage.queryTitle('Notification 6')).not.toBeInTheDocument()
  })

  it('activates a row when clicked', async () => {
    const onActivate = vi.fn()
    const items = buildDropdownItems()
    notificationDropdownPage.render({ items, onActivate })

    await notificationDropdownPage.clickRow('Accept your score')

    expect(onActivate).toHaveBeenCalledTimes(1)
    expect(onActivate).toHaveBeenCalledWith(items[0])
  })

  it('fires mark-all-read', async () => {
    const onMarkAllRead = vi.fn()
    notificationDropdownPage.render({ unreadCount: 2, onMarkAllRead })
    await notificationDropdownPage.clickMarkAllRead()
    expect(onMarkAllRead).toHaveBeenCalledTimes(1)
  })

  it('fires see-all', async () => {
    const onSeeAll = vi.fn()
    notificationDropdownPage.render({ onSeeAll })
    await notificationDropdownPage.clickSeeAll()
    expect(onSeeAll).toHaveBeenCalledTimes(1)
  })
})

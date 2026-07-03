import { buildNotificationsItems } from './notifications-view.factory'
import { notificationsViewPage } from './notifications-view.page'

describe('NotificationsView', () => {
  it('lists every notification under the "all" filter', () => {
    notificationsViewPage.render({ filter: 'all' })
    expect(notificationsViewPage.queryTitle('Confirm your score')).toBeInTheDocument()
    expect(notificationsViewPage.queryTitle('Rating +12')).toBeInTheDocument()
    expect(
      notificationsViewPage.queryTitle('Spring Open · R16 posted'),
    ).toBeInTheDocument()
  })

  it('marks the active filter pill as pressed', () => {
    notificationsViewPage.render({ filter: 'unread' })
    expect(notificationsViewPage.getFilter('Unread')).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(notificationsViewPage.getFilter('All')).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })

  it('shows only unread notifications under the "unread" filter', () => {
    notificationsViewPage.render({ filter: 'unread' })
    expect(notificationsViewPage.queryTitle('Confirm your score')).toBeInTheDocument()
    expect(notificationsViewPage.queryTitle('Rating +12')).not.toBeInTheDocument()
  })

  it('keeps an unread row visible after it auto-marks-read (#762)', () => {
    const items = buildNotificationsItems()
    const { rerenderWith } = notificationsViewPage.render({
      items,
      filter: 'unread',
    })
    expect(notificationsViewPage.queryTitle('Confirm your score')).toBeInTheDocument()

    // The row is seen and auto-marked-read: the feed cache flips its read_at.
    const readNow = items.map((item) =>
      item.id === 'n-1' ? { ...item, read_at: '2026-07-03T00:00:00.000Z' } : item,
    )
    rerenderWith({ items: readNow, filter: 'unread' })

    // It stays on screen (just loses the unread emphasis) instead of vanishing.
    expect(notificationsViewPage.queryTitle('Confirm your score')).toBeInTheDocument()
  })

  it('filters by category', () => {
    notificationsViewPage.render({ filter: 'rating_change' })
    expect(notificationsViewPage.queryTitle('Rating +12')).toBeInTheDocument()
    expect(
      notificationsViewPage.queryTitle('Confirm your score'),
    ).not.toBeInTheDocument()
  })

  it('shows the empty state when a filter matches nothing', () => {
    notificationsViewPage.render({ filter: 'match_reminder' })
    expect(notificationsViewPage.queryEmptyState()).toBeInTheDocument()
  })

  it('reports the unread count', () => {
    notificationsViewPage.render({ unreadCount: 4 })
    expect(notificationsViewPage.queryUnreadBadge()).toHaveTextContent('4 unread')
  })

  it('disables mark-all-read with nothing unread', () => {
    notificationsViewPage.render({ unreadCount: 0 })
    expect(notificationsViewPage.getMarkAllRead()).toBeDisabled()
  })

  it('changes the filter when a pill is clicked', async () => {
    const onFilterChange = vi.fn()
    notificationsViewPage.render({ onFilterChange })
    await notificationsViewPage.clickFilter('Unread')
    expect(onFilterChange).toHaveBeenCalledWith('unread')
  })

  it('activates a notification when its row is clicked', async () => {
    const onActivate = vi.fn()
    const items = buildNotificationsItems()
    notificationsViewPage.render({ items, onActivate })
    await notificationsViewPage.clickRow('Confirm your score')
    expect(onActivate).toHaveBeenCalledWith(items[0])
  })

  it('fires mark-all-read', async () => {
    const onMarkAllRead = vi.fn()
    notificationsViewPage.render({ unreadCount: 2, onMarkAllRead })
    await notificationsViewPage.clickMarkAllRead()
    expect(onMarkAllRead).toHaveBeenCalledTimes(1)
  })
})

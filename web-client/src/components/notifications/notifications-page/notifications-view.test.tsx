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

  it('keeps a seen row visible after it auto-marks-read (#762)', () => {
    const items = buildNotificationsItems()
    // n-1 has been seen (auto-mark-read pins it via stickyUnread).
    const stickyUnread = new Set(['n-1'])
    const { rerenderWith } = notificationsViewPage.render({
      items,
      filter: 'unread',
      stickyUnread,
    })
    expect(notificationsViewPage.queryTitle('Confirm your score')).toBeInTheDocument()

    // The auto-mark-read lands: the feed cache flips the row's read_at.
    const readNow = items.map((item) =>
      item.id === 'n-1' ? { ...item, read_at: '2026-07-03T00:00:00.000Z' } : item,
    )
    rerenderWith({ items: readNow, filter: 'unread', stickyUnread })

    // It stays on screen (just loses the unread emphasis) instead of vanishing.
    expect(notificationsViewPage.queryTitle('Confirm your score')).toBeInTheDocument()
  })

  it('drops a read row that was never pinned from the unread filter', () => {
    const items = buildNotificationsItems().map((item) =>
      item.id === 'n-1' ? { ...item, read_at: '2026-07-03T00:00:00.000Z' } : item,
    )
    // Empty snapshot: nothing was seen, so a read row (e.g. Mark all read, or a
    // read on another tab) is not kept around.
    notificationsViewPage.render({ items, filter: 'unread', stickyUnread: new Set() })
    expect(
      notificationsViewPage.queryTitle('Confirm your score'),
    ).not.toBeInTheDocument()
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

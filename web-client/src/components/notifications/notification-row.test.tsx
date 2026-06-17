import { buildNotificationItem } from './notification-row.factory'
import { notificationRowPage } from './notification-row.page'

describe('NotificationRow', () => {
  it('renders the title and body', () => {
    notificationRowPage.render({
      notification: buildNotificationItem({
        title: "You're up next",
        body: 'Court 3 · vs Silva, R.',
      }),
    })
    expect(notificationRowPage.getText("You're up next")).toBeInTheDocument()
    expect(notificationRowPage.getText('Court 3 · vs Silva, R.')).toBeInTheDocument()
  })

  it('marks an unread row with the card wash and an sr-only marker', () => {
    notificationRowPage.render({
      notification: buildNotificationItem({ read_at: null }),
    })
    expect(notificationRowPage.getRow()).toHaveAttribute('data-unread', 'true')
    expect(notificationRowPage.getRow()).toHaveStyle({
      background: 'rgba(255, 122, 26, 0.06)',
    })
    expect(notificationRowPage.queryUnreadMarker()).toBeInTheDocument()
  })

  it('does not mark a read row', () => {
    notificationRowPage.render({
      notification: buildNotificationItem({
        read_at: '2026-06-17T11:00:00.000Z',
      }),
    })
    expect(notificationRowPage.getRow()).toHaveAttribute('data-unread', 'false')
    expect(notificationRowPage.queryUnreadMarker()).not.toBeInTheDocument()
  })

  it('shows a positive rating delta in serve-green', () => {
    notificationRowPage.render({
      notification: buildNotificationItem({ delta: '+12', action_label: null }),
    })
    expect(notificationRowPage.getText('+12')).toHaveStyle({
      color: 'var(--serve-500)',
    })
  })

  it('shows a negative rating delta in loss-red', () => {
    notificationRowPage.render({
      notification: buildNotificationItem({ delta: '-8', action_label: null }),
    })
    expect(notificationRowPage.getText('-8')).toHaveStyle({
      color: 'var(--loss)',
    })
  })

  it('renders the call-to-action label when present', () => {
    notificationRowPage.render({
      notification: buildNotificationItem({ action_label: 'Accept' }),
    })
    expect(notificationRowPage.getText('Accept')).toBeInTheDocument()
  })

  it('omits the call-to-action when there is none', () => {
    notificationRowPage.render({
      notification: buildNotificationItem({ action_label: null }),
    })
    expect(notificationRowPage.queryText('Review')).not.toBeInTheDocument()
  })

  it('renders a compact relative timestamp', () => {
    notificationRowPage.render({
      notification: buildNotificationItem({
        created_at: '2026-06-17T11:58:00.000Z',
      }),
    })
    // ROW_NOW is two minutes later.
    expect(notificationRowPage.getText('2m')).toBeInTheDocument()
  })

  it('calls onActivate with the notification when clicked', async () => {
    const onActivate = vi.fn()
    const notification = buildNotificationItem({ id: 'n-42' })
    notificationRowPage.render({ notification, onActivate })

    await notificationRowPage.clickRow()

    expect(onActivate).toHaveBeenCalledTimes(1)
    expect(onActivate).toHaveBeenCalledWith(notification)
  })
})

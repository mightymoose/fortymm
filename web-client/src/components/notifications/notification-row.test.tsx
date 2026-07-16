import { render } from '@/test/utilities'
import { NotificationRow } from './notification-row'
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

  it('renders a match_calls item — the calls category is drawable like any other', () => {
    // The category the pin transaction fires (ADR "the schedule is solved; the
    // call is pinned": called / moved / cancelled). The row renders any category
    // generically off CATEGORY_VISUAL, so this pins that the new category has a
    // visual and flows through the shared row unchanged.
    notificationRowPage.render({
      notification: buildNotificationItem({
        category: 'match_calls',
        title: 'You’re called: Table 3',
        body: 'U1200 Singles vs Okafor, D. — head to Table 3 now.',
      }),
    })
    expect(notificationRowPage.getText('You’re called: Table 3')).toBeInTheDocument()
    expect(
      notificationRowPage.getText('U1200 Singles vs Okafor, D. — head to Table 3 now.'),
    ).toBeInTheDocument()
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

  describe('onSeen (auto mark-read on scroll into view)', () => {
    class MockIntersectionObserver {
      static instances: MockIntersectionObserver[] = []
      private elements: Element[] = []
      private cb: IntersectionObserverCallback
      constructor(cb: IntersectionObserverCallback) {
        this.cb = cb
        MockIntersectionObserver.instances.push(this)
      }
      observe(el: Element) {
        this.elements.push(el)
      }
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return []
      }
      /** Simulate the observed rows crossing the visibility threshold. */
      enterView() {
        this.cb(
          this.elements.map(
            (target) => ({ isIntersecting: true, target }) as IntersectionObserverEntry,
          ),
          this as unknown as IntersectionObserver,
        )
      }
    }

    beforeEach(() => {
      MockIntersectionObserver.instances = []
      vi.stubGlobal('IntersectionObserver', MockIntersectionObserver)
    })
    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('fires onSeen with the id once an unread row scrolls into view', () => {
      const onSeen = vi.fn()
      notificationRowPage.render({
        notification: buildNotificationItem({ id: 'n-7', read_at: null }),
        onSeen,
      })

      expect(onSeen).not.toHaveBeenCalled() // not yet on screen
      MockIntersectionObserver.instances[0].enterView()

      expect(onSeen).toHaveBeenCalledTimes(1)
      expect(onSeen).toHaveBeenCalledWith('n-7')
    })

    it('does not observe an already-read row', () => {
      const onSeen = vi.fn()
      notificationRowPage.render({
        notification: buildNotificationItem({
          read_at: '2026-06-17T11:00:00.000Z',
        }),
        onSeen,
      })

      expect(MockIntersectionObserver.instances).toHaveLength(0)
      expect(onSeen).not.toHaveBeenCalled()
    })

    it('does not track when no onSeen handler is given', () => {
      notificationRowPage.render({
        notification: buildNotificationItem({ read_at: null }),
      })
      expect(MockIntersectionObserver.instances).toHaveLength(0)
    })

    it('does not re-fire after an optimistic read rolls back to unread', () => {
      // Simulates the failed-mark rollback: unread -> read (optimistic) -> unread
      // again. The row must not re-arm and re-report, or a failing endpoint would
      // get hammered every debounce window.
      const onSeen = vi.fn()
      const unread = buildNotificationItem({ id: 'n-9', read_at: null })
      const { rerender } = render(
        <NotificationRow notification={unread} onSeen={onSeen} />,
      )

      MockIntersectionObserver.instances[0].enterView()
      expect(onSeen).toHaveBeenCalledTimes(1)
      expect(MockIntersectionObserver.instances).toHaveLength(1)

      // Optimistic mark-read, then a rollback flips it back to unread.
      rerender(
        <NotificationRow
          notification={{ ...unread, read_at: '2026-06-17T12:00:00.000Z' }}
          onSeen={onSeen}
        />,
      )
      rerender(<NotificationRow notification={unread} onSeen={onSeen} />)

      // The once-ever guard means no new observer was armed by the rollback, so
      // there's nothing left to re-fire onSeen.
      expect(MockIntersectionObserver.instances).toHaveLength(1)
      expect(onSeen).toHaveBeenCalledTimes(1)
    })
  })
})

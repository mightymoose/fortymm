import { renderHook } from '@/test/utilities'

const { pushMock, mutateMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  mutateMock: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ history: { push: pushMock } }),
}))
vi.mock('@/api/notifications', () => ({
  useMarkNotificationRead: () => ({ mutate: mutateMock }),
}))

// Imported after the mocks are declared (vi.mock is hoisted above all imports).
import { buildNotificationItem } from './notification-row.factory'
import { useFollowNotification } from './use-follow-notification'

describe('useFollowNotification', () => {
  beforeEach(() => {
    pushMock.mockClear()
    mutateMock.mockClear()
  })

  it('marks an unread notification read and follows its link', () => {
    const { result } = renderHook(() => useFollowNotification())
    result.current(
      buildNotificationItem({ id: 'n-1', read_at: null, link: '/matches/m-1' }),
    )
    expect(mutateMock).toHaveBeenCalledWith('n-1')
    expect(pushMock).toHaveBeenCalledWith('/matches/m-1')
  })

  it('does not re-mark an already-read notification but still navigates', () => {
    const { result } = renderHook(() => useFollowNotification())
    result.current(
      buildNotificationItem({
        read_at: '2026-01-01T00:00:00.000Z',
        link: '/matches/m-1',
      }),
    )
    expect(mutateMock).not.toHaveBeenCalled()
    expect(pushMock).toHaveBeenCalledWith('/matches/m-1')
  })

  it('navigates nowhere when the notification has no link', () => {
    const { result } = renderHook(() => useFollowNotification())
    const notification = buildNotificationItem({ read_at: null, link: null })
    result.current(notification)
    expect(mutateMock).toHaveBeenCalledWith(notification.id)
    expect(pushMock).not.toHaveBeenCalled()
  })
})

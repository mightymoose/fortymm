import { useMutation } from '@tanstack/react-query'
import { api, unwrap } from './client'
import type { components } from './schema'

export type TestNotificationResult =
  components['schemas']['TestNotificationResponse']

/**
 * Fire a test push to the current user's registered iOS devices. The backend
 * fans out to every device token the signed-in user has registered (so you must
 * be signed into the same account in the iOS app) and reports how many were
 * delivered. Callers await via `mutateAsync` and catch `ApiError` — a 503 means
 * push isn't configured on the server.
 */
export function useSendTestNotification() {
  return useMutation({
    mutationFn: async (): Promise<TestNotificationResult> =>
      unwrap('send test notification', await api.POST('/v1/notifications/test')),
  })
}

import { delay, http, HttpResponse } from 'msw'
import { healthResponse, sessionResponse } from '@/test/factories'

export const mockSession = sessionResponse({ user: { username: 'rita.kovac' } })
export const mockHealthy = healthResponse()

export const handlers = [
  http.get('*/v1/health', async () => {
    await delay(400)
    return HttpResponse.json(mockHealthy)
  }),

  http.get('*/v1/session', async () => {
    await delay(600)
    return HttpResponse.json(mockSession)
  }),
]

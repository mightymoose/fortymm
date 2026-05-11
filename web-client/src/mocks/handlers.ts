import { delay, http, HttpResponse } from 'msw'
import type { components } from '@/api/schema'

type SessionResponse = components['schemas']['SessionResponse']

export const mockSession: SessionResponse = {
  data: {
    user: {
      username: 'rita.kovac',
    },
  },
}

export const handlers = [
  http.get('/api/health', () => {
    return HttpResponse.json({ status: 'ok' })
  }),

  http.get('*/v1/session', async () => {
    await delay(600)
    return HttpResponse.json(mockSession)
  }),
]

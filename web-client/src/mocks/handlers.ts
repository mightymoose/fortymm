import { delay, http, HttpResponse } from 'msw'
import type { components } from '@/api/schema'

type SessionResponse = components['schemas']['SessionResponse']
type HealthResponse = components['schemas']['HealthResponse']

export const mockSession: SessionResponse = {
  data: {
    user: {
      username: 'rita.kovac',
    },
  },
}

export const mockHealthy: HealthResponse = {
  redis: { healthy: true, latency_ms: 4 },
  database: { healthy: true, latency_ms: 12 },
  solver: { healthy: true, latency_ms: 38 },
}

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

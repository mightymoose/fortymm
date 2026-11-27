import { queryOptions } from '@tanstack/react-query'
import { z } from 'zod'
import { health, type DocumentHealth } from '../api/generated.ts'

// Checked at runtime, and against the generated type at compile time: if the api's spec changes,
// this stops compiling until it matches.
export const healthDocument = z.object({
  data: z.object({ server: z.literal('ok') }),
}) satisfies z.ZodType<DocumentHealth>

export const healthQuery = queryOptions({
  queryKey: ['health'],
  queryFn: async ({ signal }) => {
    const response = await health({ signal })
    // The generated fetch returns every response; only a 200 carries the document.
    if (response.status !== 200) throw new Error(`GET /api/v1/health: ${response.status}`)
    return healthDocument.parse(response.data)
  },
})

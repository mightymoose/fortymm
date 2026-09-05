import { z } from 'zod'
import { ApiError } from './client'

const scoreSaveContextSchema = z.object({
  scoreBaseline: z.object({ id: z.string(), version: z.number() }).nullable(),
})

export type ScoreSaveContext = z.infer<typeof scoreSaveContextSchema>

export function readScoreSaveContext(
  context: unknown,
): ScoreSaveContext | undefined {
  const parsed = scoreSaveContextSchema.safeParse(context)
  return parsed.success ? parsed.data : undefined
}

/** A failed attempt keeps the committed identity it was made against. Newer
 * server truth makes it a conflict even if the attempt failed before a 409
 * could reach us. The same check protects review UI and imperative retries. */
export function scoreBaselineConflict(
  context: ScoreSaveContext | undefined,
  committed: { id: string; version: number } | null,
): ApiError | null {
  if (!context) return null
  const original = context.scoreBaseline
  if (
    original?.id === committed?.id &&
    original?.version === committed?.version
  ) {
    return null
  }
  const message = 'This game changed since your score was entered.'
  return new ApiError(409, message, 'retry score', {
    detail: { message, committed_score: committed },
  })
}

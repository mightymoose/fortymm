import { useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { z } from 'zod'

import { ApiError } from '@/api/client'
import { nextScoringDestination, useCreateMatch } from '@/api/matches'

import type { Opponent } from './opponent'

// Rated matches need an opponent; the API enforces this independently. The
// client toggle is disabled when no opponent is picked, so this only fires
// in a near-impossible race — keep the refinement for defense in depth.
const matchFormSchema = z
  .object({
    hasOpponent: z.boolean(),
    rated: z.boolean(),
    bestOf: z.number(),
  })
  .refine((value) => !(value.rated && !value.hasOpponent), {
    message:
      'A rated match needs an opponent — pick one, or switch off Rated.',
    path: ['opponent'],
  })

export interface StartMatchInput {
  opponent: Opponent | null
  bestOf: number
  rated: boolean
}

export interface UseStartMatchResult {
  submit: (input: StartMatchInput) => void
  apiError: string | null
  submitting: boolean
  submitted: boolean
  // Reads the submit guard's *live* value, not a snapshot from the render
  // that created this closure — a caller gating a `useBlocker` shouldBlockFn
  // on "has this form already succeeded?" needs the answer as of the instant
  // the navigation this hook triggers actually fires, which can land before
  // React re-renders with a fresh `submitting`/`submitted` value.
  hasSucceeded: () => boolean
}

/**
 * Shared match-creation submit machinery for the match-setup form: validates,
 * guards against a double-submit, creates the match, and routes to scoring.
 * Since the refinement above is defense-in-depth only (the UI can't produce
 * an invalid combination), a validation failure is surfaced through the same
 * `apiError` field as a server error rather than recomputed live.
 */
export function useStartMatch(): UseStartMatchResult {
  const navigate = useNavigate()
  const createMatch = useCreateMatch()

  const [apiError, setApiError] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState(false)
  // Synchronous submit guard. `'submitting'` blocks the double-click race before
  // `isPending` flips on a batched re-render; `'done'` latches after a match is
  // created so the same mounted form (e.g. restored from the bfcache on Back)
  // can't fire a duplicate create (#81). A failed attempt resets to `'idle'`.
  const submitState = useRef<'idle' | 'submitting' | 'done'>('idle')

  async function submit({ opponent, bestOf, rated }: StartMatchInput) {
    setSubmitted(true)
    const validation = matchFormSchema.safeParse({
      hasOpponent: opponent !== null,
      rated,
      bestOf,
    })
    if (!validation.success) {
      setApiError(
        validation.error.issues[0]?.message ?? 'Check the match setup.',
      )
      return
    }
    // Refuse a second create from this form: a rapid double-click (before
    // `isPending` disables the button) or a re-submit after we already started
    // a match would otherwise create a duplicate (#81).
    if (submitState.current !== 'idle') return
    submitState.current = 'submitting'
    setApiError(null)

    try {
      const created = await createMatch.mutateAsync({
        opponent_user_id: opponent?.id ?? null,
        best_of: bestOf,
        rated: opponent !== null && rated,
      })
      submitState.current = 'done'
      // Replace, don't push: the new-match form is a one-shot step, so the
      // history stack shouldn't keep it. Otherwise browser/mobile Back from
      // score entry re-opens the creation form for a match that already
      // exists, instead of returning to wherever the user came from (#441).
      navigate({ ...nextScoringDestination(created), replace: true })
    } catch (err) {
      // Let the user try again — only a *successful* create latches the guard.
      submitState.current = 'idle'
      // A lapsed session on create surfaces as a `session_ended` 401, which the
      // global response middleware (`setSessionEndedHandler`) already catches and
      // redirects to `/login` — no local "sign in again" recovery needed here
      // (this supersedes the inline CTA #70 added, back when the same case was a
      // bare, code-less 401 the global handler ignored). Any other failure shows
      // inline.
      setApiError(
        err instanceof ApiError
          ? (err.detail ?? err.message)
          : 'Could not start the match. Try again.',
      )
    }
  }

  return {
    submit,
    apiError,
    submitting: createMatch.isPending,
    submitted,
    hasSucceeded: () => submitState.current === 'done',
  }
}

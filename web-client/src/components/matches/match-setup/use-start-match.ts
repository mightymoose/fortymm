import { useEffect, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { z } from 'zod'

import { ApiError } from '@/api/client'
import { nextScoringDestination, useCreateMatch } from '@/api/matches'

import {
  isRatable,
  selectedOpponent,
  type OpponentSelection,
} from './opponent-selection'

// Rated matches need an opponent; the API enforces this independently. The
// client toggle is disabled when no opponent is picked, so this only fires
// in a near-impossible race — keep the refinement for defense in depth.
//
// `hasOpponent` comes from `isRatable(selection)`, so a `seeking` selection (a
// typed-but-uncommitted search, #893) is treated exactly like `none`: not an
// opponent, therefore not rateable.
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
  /**
   * The full selection, not a bare `Opponent | null` — the send-time coercion
   * below is one of the places that has to agree on "no opponent ⇒ solo and
   * unrated", and taking the sum type is what stops it disagreeing with the UI
   * about what a `seeking` selection means (#893).
   */
  selection: OpponentSelection
  bestOf: number
  rated: boolean
}

export interface UseStartMatchResult {
  submit: (input: StartMatchInput) => void
  apiError: string | null
  submitting: boolean
  submitted: boolean
  // A caller gating a `useBlocker` shouldBlockFn on "has this form already
  // succeeded?" needs the live value as of the instant the navigation this
  // hook triggers actually fires, which can land before React re-renders with
  // a fresh `submitting`/`submitted` value — a ref read does that, a
  // state-derived boolean wouldn't.
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
  // can't fire a duplicate create (#81). A failed attempt resets to `'idle'`,
  // which also doubles as the dirty-form blocker's escape hatch (#75):
  // `hasSucceeded()` below reads this same ref, so a retry-after-error
  // correctly re-arms the blocker instead of leaving it permanently bypassed.
  //
  // Deliberately NOT migrated to `ignoreBlocker` like score entry was (ADR
  // 0014, #818). This is a terminal state — "this form has been spent" — that
  // is permanent by design (it must outlive its navigation to stop a
  // bfcache-restored form from creating a second match, #81), not a
  // one-hop-sanctioned permission. And `ignoreBlocker` could not replace it
  // anyway: `hasSucceeded()` is read by `enableBeforeUnload`, and closing a tab
  // is not a `navigate()` call, so no navigation option can reach that path.
  const submitState = useRef<'idle' | 'submitting' | 'done'>('idle')

  // Tracks whether this hook's component is still mounted, so the async success
  // branch below can tell a still-open form from one the user has already left.
  // Set true in the body (not just false in cleanup): under React StrictMode the
  // effect is mount→cleanup→remount, so a cleanup-only ref would latch false on
  // the first simulated unmount and never recover, permanently suppressing the
  // redirect in dev. Re-asserting true on (re)mount is the canonical is-mounted
  // pattern.
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  async function submit({ selection, bestOf, rated }: StartMatchInput) {
    setSubmitted(true)
    // One reading of the selection, shared by the refinement and the payload —
    // `seeking` collapses to "no opponent" here, and only here.
    const opponent = selectedOpponent(selection)
    const validation = matchFormSchema.safeParse({
      hasOpponent: isRatable(selection),
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
        rated: isRatable(selection) && rated,
      })
      // Latch the #81 duplicate-create guard BEFORE the mount gate so
      // `hasSucceeded()` and the "this form is spent" contract are unchanged
      // whether or not we still redirect.
      submitState.current = 'done'
      // Gate the redirect on the form still being mounted:
      //   (1) A user who navigated away mid-request must not be yanked back to
      //       the new match's scoring page against their choice to leave (#810).
      //   (2) Background-complete, not abort: the create above already finished,
      //       so the match lands in their list via the `['matches','list']`
      //       invalidation — we only suppress the redirect, never cancel the POST.
      //   (3) bfcache doesn't confound the unmount signal: a page with an
      //       in-flight `fetch` is bfcache-ineligible, so a mid-request Back is a
      //       real React unmount that flips `mountedRef`, not a frozen page.
      if (mountedRef.current) {
        // Replace, don't push: the new-match form is a one-shot step, so the
        // history stack shouldn't keep it. Otherwise browser/mobile Back from
        // score entry re-opens the creation form for a match that already
        // exists, instead of returning to wherever the user came from (#441).
        navigate({ ...nextScoringDestination(created), replace: true })
      }
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

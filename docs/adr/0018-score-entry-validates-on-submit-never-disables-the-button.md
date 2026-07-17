# 18. Score entry validates on submit and never disables the submit button

Date: 2026-07-17

## Status

Accepted

## Context

The single-game score-entry surface (`web-client/src/components/matches/score-entry.tsx`
+ the shared `score-pad`) hand-rolled its form: two `useState` strings
(`meTyped`/`oppTyped`), a shared `validateGameScore` verdict recomputed every
render, and a submit button gated on validity (`canSubmit={inputsValid && …}`,
`disabled={!canSubmit}`). Errors painted **live** — a half-typed "8–5" went red
before the user had finished, and the disabled button gave no reason it couldn't
be pressed.

We are moving the surface onto React Hook Form + Zod (the app's standard form
stack — `@hookform/resolvers`, `event-editor.tsx`, the rbac pages), and the
propose-a-result correction board (`correction-entry.tsx`, which shares
`validate-game-score.ts` today) will follow in a later pass. That makes the form
posture here a **pattern**, not a one-off, so it is worth pinning down.

Two forces shape the decision. First, gating a submit button on `isValid` is a
known foot-gun in this codebase (it forces a `useEffect(trigger)` dance for edit
forms and tells the user "no" without saying why). Second, `score-entry.tsx` is
mostly **not** a form: the two typed strings feed ~ten downstream live consumers
— the finalize-vs-save prediction (`wouldFinalize`, `hypotheticalGames`), the
unsaved-changes router blocker's failed-save-aware dirty baseline (ADR-0014), the
cross-game `overrunAt` block, and the live button copy — none of which are form
validation and several of which guard against silent data loss.

## Decision

**The submit button is always enabled; validation errors appear only after the
first submit attempt; and React Hook Form owns only the two fields and their
input validation — nothing else.**

Concretely:

1. **Never disable the button on validity.** `handleSubmit` is the only gate — an
   invalid submit runs validation and fires nothing. The button is disabled only
   by genuine *in-flight* locks (`inputsLocked`: finalize pending / 409-redirect
   window), never by `isValid`. This is the general rule from the
   don't-gate-submit-on-validity guidance, made explicit for this surface.

2. **Errors are silent until the first submit.** `mode: 'onSubmit'` +
   `reValidateMode: 'onChange'`: no red fields or messages while first typing;
   the first click surfaces them; thereafter they re-validate live so a fix
   clears the red immediately. Because the button is now always live, the
   previously-unreachable **empty submit** must give feedback — a fully empty (or
   half-filled) form submits to the soft "Enter both scores to save this game."
   hint on the empty side(s), not silence.

3. **RHF owns the two fields and Zod owns their validation — full stop.** The
   fields are driven through a `Controller` (to keep the #624 keystroke input
   filter, `isAcceptableScoreInput`), the live values are read back with
   `useWatch`, and every downstream consumer — dirty tracking, finalize
   prediction, `overrunAt`, server/finalize errors, the scoreline — stays
   component logic reading the watched values, **outside** the form. We
   deliberately do **not** route dirty state through `formState.isDirty` (it
   compares to `defaultValues` and cannot see the failed-save scratch baseline —
   the exact ADR-0014 silent-data-loss trap) nor server errors through
   `setError('root')` (the finalize 409/422/500/network/redirect interplay,
   #868/#827, is too subtle to launder through form state).

4. **Cross-game and server errors follow the same "after submit" gate as Zod
   errors where they can.** `overrunAt` (a locally-legal score the board can't
   take) and the both-required hint render only once `submitCount > 0`. Server /
   finalize errors are inherently post-submit and surface as they do today.

5. **The Zod schema and its issues→UI mapper are built as reusable primitives**
   in `score-pad/` (beside `validate-game-score.ts`), reusing the shared
   `illegalScoreReason` rule, so the correction board can adopt them next without
   a rewrite. `validateGameScore` is left untouched for correction-entry this
   pass and retired when that surface migrates.

## Consequences

- The user can always press the button and always learns why a press did
  nothing — no more silent disabled state, no `useEffect(trigger)` workaround.
- The migration is behavior-preserving **except** the two intentional changes
  (always-enabled button; errors-after-first-submit incl. the new empty-submit
  hint). The existing 3,399-line `score-entry.test.tsx` suite must stay green
  through it, extended with tests for those two behaviors.
- Because RHF owns only the fields, the delicate data-loss guards (ADR-0014
  dirty baseline, #868 finalize-network branch, #827 409-redirect calm notice)
  are carried across unchanged rather than reimplemented on form state.
- The new pure logic (schema + mapper) is small and fully testable; the mutation
  bar is 100% mutants killed on it, measured via `test:mutation:changed`, with no
  regression to the component's existing killed-mutant set. No CI `break` gate is
  added (the Stryker config keeps `break: null`).
- A second surface (correction-entry) is expected to follow this same posture;
  the primitives in `score-pad/` are the seam it will reuse.

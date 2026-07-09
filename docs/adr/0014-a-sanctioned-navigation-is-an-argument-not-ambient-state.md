---
status: accepted
---

# A sanctioned navigation is an argument, not ambient state (#818)

A dirty-form guard (`useBlocker`) has to let *some* navigations through: the ones the
app itself performs on the user's behalf. Score entry saves a game and hops to the
next one; finalize posts the result and lands on the match page; clearing a game
recreates its empty route. None of those should pop "Leave without saving?".

`score-entry.tsx` bought that exemption with a ref latch — `navOverride.arm()`, a
boolean set just before a save, read by `shouldBlockFn`. The hook
(`use-navigation-override-ref.ts`) had no `disarm()`, so once armed it stayed armed
for the life of the component instance.

Two of `onSubmit`'s exit paths never navigate at all. The **offline deciding-game
save** returns early so the `SaveBanner` can surface its retry prompt, and
**`overwriteWithMyScore()`** only patches the query cache. Both armed the latch and
consumed nothing. From then on the guard was dead — and not merely for the app's own
hops. The armed latch also waved through the **scoreline `<Link>`**, the exact
user-initiated navigation the guard was built to catch. A user could type a score,
hit Save on the offline decider, click the scoreline strip, and lose the edit with no
prompt.

## Decision

**The app's own navigations bypass the guard; the user's navigations do not.**

**The axis is what triggered the navigation, not which file it lives in.** A
navigation fired from a mutation's success callback is the app's; a navigation fired
from an `onClick` or a `<Link>` is the user's — even though both are "app code", and
even though both may run while the form is dirty.

This matters because `useBlocker` guards every navigation attempted while its
component is mounted, *including those fired by that component's children*. The scope
is the blocker's subtree, and a subtree can hold both categories.

`SaveBanner` is exactly that case. It renders inside `ScoreEntryInner` and fires two
`navigate()` calls, which fall on opposite sides of the rule:

- `retry()`'s `finalizeMutation.mutate(…, { onSuccess: () => navigate(…) })` — the app
  navigating as a consequence of a write the user already committed. The result has
  posted; `isDirty` is merely stale. **Bypass.**
- `ConflictReviewBanner`'s "Review game N" `onClick={() => navigate(…)}` — the user
  choosing to jump to another game, the same gesture as the scoreline `<Link>`.
  **Block**, and warn them about the input they typed.

Deleting the always-armed latch uncovered both, because the latch had been suppressing
the guard for the whole subtree, indiscriminately, for the life of the component. The
finalize hop needed the bypass restored. The Review button did not: it had been
silently discarding typed input for as long as the latch existed, and the guard firing
there is the fix working, not a regression.

Do not reach for "would data actually be lost?" as the test. A failed save survives an
in-app hop in the mutation cache, so often nothing is lost — yet the user still asked
to leave a form they had typed into, and still deserves the prompt. The rule is
categorical: **who initiated this navigation?**

Express that by passing `ignoreBlocker: true` **to the navigation being performed** —
never by setting a flag that the blocker later reads:

```ts
navigate({ ...matchDetailRoute(matchId), ignoreBlocker: true })
```

`ignoreBlocker` is a first-class `NavigateOptions` field in `@tanstack/router-core`.
Because it is an argument to a navigation that is *definitely happening*, there is no
"maybe I'll navigate" state that can outlive the one call it was meant for. There is
nothing to leak, because nothing is stored.

The deciding argument is the **asymmetry of the failure modes**, not the tidiness:

- Forgetting `ignoreBlocker` on a new app-initiated `navigate()` is **fail-safe** —
  the user gets a spurious "Leave without saving?" prompt. Annoying; nothing is lost.
- Forgetting a `disarm()` on a new early-return is **fail-open** — the guard silently
  dies and unsaved input is discarded without warning. That is #818.

`onSubmit` already had four exit paths. Prefer the mechanism whose failure mode is
annoying over the one whose failure mode is destructive.

## Corollary: a spent form is not a sanctioned hop

`use-start-match.ts` holds a ref that *looks* like the same latch — `submitState`,
which latches to `'done'` and never clears — and was flagged as the same bug. It is
not, and it must not be "fixed".

The two flags answer different questions:

- `navOverride` meant **"the navigation I am about to perform is sanctioned."** It is
  a property of *one imminent navigation*. Anything that outlives that navigation is
  a bug.
- `submitState === 'done'` means **"this form has been spent."** It is a property of
  *the form's lifetime*, and it is supposed to be permanent: once the match exists, a
  bfcache-restored form must neither create a second one (#81) nor nag about unsaved
  changes.

One is a transient permission; the other a terminal state. #818 is what happens when
a transient permission is implemented with a mechanism that makes it terminal.

Independently, `ignoreBlocker` **could not** replace `submitState` even if we wanted
it to: `matches/new.tsx` reads that flag from `enableBeforeUnload`, and closing a tab
is not a `navigate()` call, so no navigation option can reach it. Two files depend on
it — `matches/new.tsx` and `dashboard/first-match/first-match-card.tsx` (#811).

## Consequence: `isDirty` stays stored state

`score-entry.tsx` keeps `isDirty` in `useState` rather than deriving it per render
from `computeDirty(me, opp)`, and that is deliberate.

The dirty baseline folds in a failed save:
`failedMe != null ? String(failedMe) : persistedMe…`. So the instant an offline save
fails, the baseline *becomes what the user typed*, and a derived `isDirty` would
compute `false`. `enableBeforeUnload` would then return `false`, and closing the tab
would discard the deciding-game score with no prompt — the score was never on the
server, and the mutation cache holding it is in-memory only (there is no
`persistQueryClient`).

Deriving `isDirty` therefore trades a stale boolean for silent data loss. It stays
stored, with a comment at the declaration saying so.

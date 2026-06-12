---
description: Extract a section of a legacy page/component into colocated strangler quartets (component + page object + factory + test).
argument-hint: <component or page section to extract>
---

Extract the target ($ARGUMENTS) from its legacy host into the standard quartet
structure. This is the strangler pattern the repo has been applying to
match-details and friends — follow the precedent of recent `extract … into
strangler quartets` commits (`git log --oneline --grep="strangler"`).

## Process

1. **Sync first:** `git fetch origin` and plan against `origin/main`, not stale
   local files — the strangler work moves fast and plans built on stale reads
   get rewritten.
2. Read the legacy host component and identify the seam: the markup + logic
   that becomes the new component, and the props it needs from the host.
3. Invoke the `react-component` skill — it defines the quartet layout
   (`.tsx`, `.page.tsx`, `.factory.tsx`, `.test.tsx`), the recursive
   supremum directory rule (a component's deps nest in its named subdirectory;
   shared deps float up to their lowest common ancestor), page-object
   composition, view models, and MSW mocking. The extracted quartet lands in
   the host's named subdirectory; if it's shared, place it at the importers'
   LCA. Canonical exemplar:
   `web-client/src/components/matches/match-details/scoreboard/`.
4. Replace the extracted markup in the host with the new component; the host's
   page object should compose the new component's page object rather than
   re-querying the DOM.
5. Keep each extraction a small, reviewable step. If the user asked for
   several sections, do them as separate commits.

## Verification

Per standing feedback: when slicing a refactor into steps, **defer
verification to the end of the branch** — don't run the full suite after each
staged extraction. Run the new/changed component tests as you go
(`npm run test -- <file>`), and leave whole-branch verification to
`/land-the-plane`.

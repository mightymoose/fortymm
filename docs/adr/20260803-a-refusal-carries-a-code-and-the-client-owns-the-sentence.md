# A refusal carries a code and the client owns the sentence

Date: 2026-08-03 (date-numbered — sequential numbers collide across concurrent
worktrees; see `scripts/check-adr-numbering.sh`)

## Status

Accepted — decided before implementation, for issue #1221. Extends ADR-0968
("entry refusals are machine-readable codes, not prose") beyond the entry
endpoint it scoped itself to.

## Context

Three refusal surfaces on the tournament detail page had drifted into three
different rules about what a director reads when the server says no:

- **`draw-panel.tsx`** renders the server's sentence *as* the copy, deliberately
  and with a docstring defending it: the 409/422 cut refusals "name the numbers
  they must change".
- **`solve-strip.tsx`** renders a client-authored headline with the server's
  sentence beneath it as mono sub-detail — "the one exception … because it is the
  actionable content".
- **`schedule-preview-modal.tsx`** discards the server's sentence entirely and
  substitutes generic copy, on the stated grounds that raw API strings never
  reach the UI.

The third is what #1221 reports. The API composes a sentence that *names the
offending draw type* (`api/app/tournaments.py`, the `UnsupportedDrawType` arm of
`_draw_refusal`): "A single_elim draw cannot be scheduled yet … Preview a
round-robin event instead." The client throws it away and shows a sentence that
names nothing, so a director with four events cannot tell which one is the
blocker.

The obvious fix — pass `error.detail` through, matching `draw-panel` — collides
with `CONTEXT.md`'s existing **Refusal code** term, which says the client
switches on the code and owns the copy, with the server's `message` "a fallback,
never a contract".

That collision is only apparent. ADR-0968 was written against clients *switching*
on prose (a byte-for-byte `error.detail === 'You have already entered this event.'`
comparison that silently reclassified refusals when the copy was reworded).
Rendering a sentence is not branching on it. But the three surfaces still could
not all be right, and #1116 required an API change to the same family of
messages anyway — so the cheap fix would have bought inconsistency at no saving.

## Decision

**A refusal carries a machine-readable `code`, and any domain fact the refusal
turns on travels with it structurally. The client switches on the code and
authors the sentence.**

For the schedule-preview `422` that means `detail: {code:
"unsupported_draw_type", draw_type: "single_elim", message: …}`. The API's
interior already models this correctly — `UnsupportedDrawType` carries the
offending `DrawType` structurally, with a docstring saying it does so "so the
HTTP/MCP layers compose their own sentence from the fact rather than parsing a
message". The MCP layer honours that. The HTTP layer flattens it to prose at the
boundary, and that flattening is the defect.

The server's `message` stays on the wire as a fallback for consumers that have no
copy of their own (raw API, and any client meeting a `code` it does not know).

## Consequences

- The client can name the draw type without parsing a sentence, which is what
  #1221 actually asked for.
- A new refusal reaching a client that predates it degrades to the server's
  fallback sentence rather than to silence.
- `draw-panel`'s server-prose rendering is **not** retroactively condemned here.
  Its refusals interpolate live numbers ("0 entrants across 2 pools"), which a
  code alone cannot reconstruct; migrating it would mean shipping those numbers
  structurally too. That is a larger change, deliberately out of scope, and the
  inconsistency is now recorded rather than accidental.

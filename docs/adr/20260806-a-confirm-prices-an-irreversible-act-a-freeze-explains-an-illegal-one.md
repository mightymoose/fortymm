# A confirm prices an irreversible act, a freeze explains an illegal one

Date: 2026-08-06

## Status

Accepted. **Delivered across three stacked slices** — this document describes the
end state, not what any one of them shipped:

| Slice | Delivers | Closes |
| --- | --- | --- |
| 1 | Confirms on **Re-cut draw** and **Delete draw**; the #1043 regression pin | #1225, #1045 |
| 2 | Confirms on **Publish**, **Start**, **End** | #1089, #1094 |
| 3 | `drawVerbFreeze` and the frozen draw verbs | #1060 |

Do not read a section here as evidence its behaviour exists yet. Check the ticket.

## Context

Six issues (#1225, #1045, #1094, #1089, #1060, #1043) report the same family of
complaint against the tournament detail page. A director clicks one button and
something they cannot undo has happened. No dialog asked. Nothing named the cost.

The page has two different problems inside that family, and they were being
reported as one:

1. **The act is legal, and irreversible.** Publish, Start, End, Re-cut draw and
   Delete draw all succeed. The director meant to click something, and the system
   did exactly what was asked. What is missing is the beat before it.
2. **The act is illegal right now.** Once a draw is under way, Re-cut and Delete
   are still offered, and the server answers 409 (#1060). The button is live for
   an action that can only fail.

These need opposite treatments, and conflating them produces the wrong fix for
one of them. A confirm on an illegal action still ends in an error. A frozen
control on a legal one blocks work the director is entitled to do.

### What is actually irreversible

The lifecycle is forward-only — `draft → published → live → archived` — with no
edge back and `archived` terminal (`app/tournament_lifecycle.py`, and
`LIFECYCLE_EDGE` in `data/lifecycle.ts`, which never offers an edge the server
would refuse). So all three edges are one-way:

- **Publish** opens public entry. It is outward-facing.
- **Start** closes registration and, since #788, turns every ready fixture into a
  real `in_progress` match. The API's own precondition docstring says both halves
  are "irreversible in practice".
- **End** moves to `archived`, which has no edge out at all.

#1089 assumed Publish was the consequential one and left Start and End open as a
product call. That reading predates #788. Start now spends the players'
attention, not just the tournament's visibility, and End is the only edge with
nowhere to go afterwards.

### #1043 was fixed by #788, not here

#1043 reported that a LIVE tournament could be left with no draw at all. Its
reasoning was explicit: the draw verbs gate on **evidence of play** rather than
on status (ADR-0786), and nothing could produce evidence yet, because fixtures
did not become matches until #788. The guard was real but vacuous.

#788 closed that without touching the guard. `materialize_live_draw` runs inside
the go-live transaction and gives every ready fixture a `match_id`, and a
`match_id` is half of what `draw_has_play` refuses on. Going live *produces* the
evidence rather than being checked against it.

Measured, not assumed: a two-event live tournament refuses DELETE and re-cut on
both events with 409, and the fixtures survive byte-for-byte
(`test_going_live_seals_every_events_draw`). With `_enforce_unplayed` disabled the
same test reds with 204 — the #1043 behaviour exactly. Two events rather than one
because the guard is scoped per event, so a single-event test cannot tell "every
event is sealed" from "the first one is".

So the status gate #1043 asked for is not needed, and adding one would freeze the
day-of re-cut that ADR-0786 deliberately preserved.

## Decision

**A confirm prices an act. A freeze explains a refusal. A control is never both,
and never neither.**

### 1. Irreversible acts get a confirm that names the consequence

Five verbs, each behind an `AlertDialog` mirroring `ConfirmCallDialog`: Publish,
Start, End, Re-cut draw, Delete draw.

The confirm button states the act — `Publish`, `Start the tournament`, `Delete
the draw` — never a bare "OK". The body names what the click spends, in the
consequence's own terms: that entry opens to the public, that matches are minted
for players and registration closes, that the tournament ends with no way back,
that the current pairings and their schedule are discarded.

The consequence is a **sum type**, as `CallConsequence` already is, so a variant
cannot be rendered without the context its copy names. A dialog that has to ask
`if (variant === 'publish')` halfway through its body is carrying two shapes in
one.

Cancel is a no-op and Escape reads as cancel. The `isPending` double-click guard
stays alongside the confirm — a confirm is not a debounce.

### 2. The first cut gets no confirm

Generating a draw for the first time is constructive and re-cuttable. It destroys
nothing, and #1094's own reasoning says so. A confirm there would train the
director to click through confirms, which is the failure mode that makes the
other five worthless.

### 3. An illegal act is frozen with its reason, not hidden

Once a draw shows evidence of play, Re-cut and Delete render **disabled with the
reason stated**, computed by a `drawVerbFreeze` returning the existing
`EditFreeze` sum type — the shape `drawTypeFreeze` and `poolSetFreeze` already
use.

This is deliberately **not** ADR-0015's "hide, never disable". That rule is about
a *permission* boundary — "a user who cannot perform the action does not see the
button", and an absent button "asks no questions". Neither clause holds here. The
director can perform this action; they could a minute ago. A button that silently
vanishes from under a person who is entitled to it asks a very loud question, and
answers none of it. ADR-0015's real complaint about `disabled` is that it is an
*unexplained* dead end, and the fix for unexplained is an explanation.

So the two rules are one rule, keyed on which thing changed:

| The reason the action is unavailable | Treatment |
| --- | --- |
| Who you are (permission) | Hidden — ADR-0015 |
| What state the resource is in | Disabled, with the reason — this ADR |

The freeze predicate **mirrors `draw_has_play` exactly** —
`winnerEntryId !== null || matchId !== null` — because the client is restating
the server's guard, not inventing a second one. Both fields are already on the
parsed `Fixture`, so this needs no API change. If the two ever disagree the
server wins, and the 409 notice is still there to say so.

The reason is associated with the control accessibly, not merely painted next to
it. #1223 is the open bug against exactly that omission in the frozen draw-type
select, and copying the pattern wholesale would copy the defect.

## Consequences

A director cannot destroy a solved schedule, publish a draft, mint a field of
matches, or end a tournament on one click. Each of the five costs a deliberate
second click that says what it is buying.

Five more dialogs is five more things between a director and their work. That is
the price, and it is why the first cut is exempt and why the freeze is not a
dialog: a confirm on an action that will 409 anyway would be pure ceremony.

The freeze restates a server guard on the client, so the two can drift. The
mirror is one expression over two fields, pinned by a test, and the server
remains the enforcement — the client is buying a better refusal, not a new rule.

#1043 is closed as fixed by #788, with `test_going_live_seals_every_events_draw`
left behind as the regression pin. The behaviour it describes is real, was real,
and would come back the moment the play guard weakened.

# A structural setting is owned by the director or derived by the system

Date: 2026-08-08 (date-numbered, because sequential numbers collide across
concurrent worktrees. See `scripts/check-adr-numbering.sh`)

## Status

Accepted. Decided during the grill for #1320, which asks how a director controls
a round-robin-then-knockout draw's structure.

Scoped to the `rr-then-ko` draw type. No other draw type gains a structural
setting from this decision.

## Context

A round-robin-then-knockout event has four structural settings. Today a director
controls one and a half of them.

**Pool count** is implicit. A director who wants six pools adds six pool rows on
the Table pools tab. Nothing on any tab states the number.

**Pool size** cannot be set at all. The cut divides the field across the pools,
so size follows from the field and the pool count.

**Membership** is always the snake. `_snake()` in `api/app/draws.py` deals
entrants 1, 2, 3, 3, 2, 1 across the pools. A director cannot place a named
entrant.

**Qualifiers per pool** is a plain number on the Basics tab. It is the one
structural setting a director types.

This misleads people. #1320 records a real director who set one pool and one
qualifier per pool. That sends one player to the bracket. The app refused the
cut, and the message it showed named the wrong cause.

The app already solves this shape of problem elsewhere. A director places a match
on a table by hand. The scheduler packs the matches the director left alone. The
placement the director made is theirs, and the solver does not move it.

## Decision

**Each structural setting is owned by the director or derived by the system. The
owner is recorded, not guessed.**

1. **Ownership is an explicit mode, stored next to the value.** Each of pool
   count, pool size and qualifiers per pool carries a mode of `automatic` or
   `manual`. Membership carries a mode of `snake` or `manual`.

2. **A present value never implies ownership.** A derived value is a number too.
   Reading ownership off "is the field filled in" would make every derived draw
   look director-owned the moment it was shown.

3. **The system stores the director's numbers and recomputes its own.** A manual
   value persists exactly as typed. An automatic value is recomputed from its
   sources every time, and is never written back into the manual slot.

4. **The system never silently changes a director's number.** If the numbers do
   not fit the field, the app reports the mismatch and offers named resolutions.
   The director applies one, or does not.

5. **Setting nothing reproduces today's behaviour.** With every mode automatic,
   pool count is the pool row count, pool size is the field split across those
   rows, membership is the snake, and qualifiers keep their existing value. An
   event that predates this work loads with every mode automatic.

The four settings and their two sources:

| Setting | The director sets | Or the system derives |
| --- | --- | --- |
| Pool count | `6 pools` | from the pool rows, or from the field and a manual pool size |
| Pool size | `5 per pool` | from the field and the pool count |
| Membership | places entrants at cut time | deals them by snake |
| Qualifiers per pool | `top 2` | from a target bracket size of 8 |

## Consequences

**The editor states the owner in words, not only in colour.** Each setting row
carries a badge reading `Automatic` or `Yours`, and a line saying where the value
came from. A director can read who owns a number without comparing shades.

**Turning a setting manual seeds it from the derived value.** The first click
changes ownership, not the number. A director who wants to nudge a number by one
does not first have to work out what it currently is.

**Qualifiers per pool moves off the Basics tab.** It is a structural setting, and
the other three now live together on a new Draw structure tab. This breaks the
field-to-tab map in `event-form.ts`, two page objects, and the rr-then-ko e2e
spec. The move is the point, so the breakage is accepted and repaired.

**The Draw structure tab is conditional.** It appears only for `rr-then-ko`. A
plain round-robin event has no knockout stage to aim at, so it gets no tab and no
pool-to-knockout settings. Single elimination and swiss are untouched.

**Switching away from `rr-then-ko` can discard a director's work.** If every mode
is automatic, nothing is lost and the switch is silent. If any setting is
manually owned, the app names the settings it is about to drop and asks first.
This is a **confirm** in the sense ADR 20260806 gives the word. It prices an
irreversible act.

**A disagreement is not a refusal.** Six pools of five seat thirty. A field of
forty does not fit. The app says so and keeps both numbers. Saving stays
available. Cutting does not, because a cut would have to invent an answer.

**Three refusals stay, and they must name the real cause.** A pool of one player,
a knockout of one player, and more qualifiers than the smallest pool holds are
impossible competitions rather than disagreements. The app blocks the save, and
reuses the existing `DegenerateDraw` copy from `api/app/draws.py` rather than
minting a second set of words for the same conditions.

**Ownership modes live in the draw settings JSON.** ADR 20260805 already makes a
draw type's settings one not-null JSON object, so this adds keys rather than
columns. There is no migration.

## Alternatives considered

**Infer ownership from whether a value is present.** Rejected. It cannot tell a
director who typed `4` from a system that derived `4`, and those two states must
behave differently the next time the field changes.

**Give every setting a segmented `Automatic / Set manually` control.** Rejected.
Four identical two-way switches stacked down a column read as a settings panel
rather than as a draw. The reference instead shows one authoritative value, a
badge, and a quiet text action.

**Let the director set only pool size, and always derive the count.** Rejected.
A pool is also a venue reservation, so a director who books six sets of tables
has already said "six pools". Taking that control away would contradict the tab
next door.

**Derive qualifiers from nothing, and require the director to type them.** Kept
partly. Qualifiers already have a stored value on every existing event, so the
automatic source has to be compatible with what is there. The automatic rule
aims at a bracket of 8, which is a constant this ADR does not persist. See the
open question below.

## Open question

**Where does the target bracket size of 8 come from?** The reference hardcodes
it. Nothing in the reference writes it, and no director-facing control sets it.
This work therefore treats it as a named constant, not as stored state, because
persisting a field that nothing writes creates a second source of truth. Whether
a director should be able to aim at a 16-player knockout is a product question
this ADR leaves open.

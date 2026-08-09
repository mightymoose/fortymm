# An event's pool count is its pool rows, and a derived count is a projection

Date: 2026-08-08 (date-numbered, because sequential numbers collide across
concurrent worktrees. See `scripts/check-adr-numbering.sh`)

## Status

Accepted. Decided during the grill for #1320. Builds on
20260808-a-structural-setting-is-owned-by-the-director-or-derived-by-the-system,
which records the ownership model this ADR resolves one hard case of.

## Context

A pool has two faces, and `CONTEXT.md` keeps them deliberately joined. A pool is
a reserved slice of the venue, and a pool is the group of entrants who play
all-play-all on that slice. Since #1226 a pool is a real row in
`tournament_event_pools`, with a name, a `position`, a date, a window, and a set
of reserved tables.

So "how many pools does this event have" already has an answer. It is
`len(event.pools)`.

The new Draw structure tab introduces a second way to arrive at a number. When a
director sets pool size by hand and leaves pool count automatic, the count is
derived:

```
poolCount = ceil(fieldSize / manualPoolSize)
```

Those two numbers can differ. A director with four pool rows who asks for pools
of five, against a preview field of forty, has derived a count of eight.

The derivation runs against a field that usually does not exist yet. A director
configures an event before registration opens, so the preview fills the event to
its player cap, or to 16 when it has no cap. The derived count is therefore a
function of an invented number.

A derived pool row cannot be created from that alone. A pool row needs a name, a
position, a date, a time window, and tables. The derivation supplies none of
them.

The reference declines to resolve this. It renders the fact line as
`Math.max(reservationCount, derivedCount)` and moves on.

## Decision

**An event's pool count is the number of pool rows it has. A derived count is a
projection of what the structure needs, and a projection that exceeds the rows is
a disagreement to report.**

1. **Nothing writes an independent pool count.** There is no `pool_count` column
   and no `pool_count` key in the draw settings JSON. Asking the event how many
   pools it has always means counting its rows.

2. **A manual pool count is a pool row count.** When a director types `6`, the
   app creates or removes pool rows through the existing write seam,
   `apply_event_pools`. The number and the rows change in one save, or neither
   does.

3. **A derived count in excess of the rows is reported, never materialised.** The
   app says the structure needs eight pools and the event has four. It does not
   invent four reservations with no date, no window, and no tables. This is the
   same "report, do not reshape" rule the ownership ADR sets for numeric
   disagreements.

4. **A resolution the director applies does create rows.** `Use 8 pools of 5` is
   an explicit act. It appends pool rows through `apply_event_pools`, continuing
   the existing letter sequence, taking the last existing pool's date and window,
   and reserving no tables. The director then completes them on the Table pools
   tab.

5. **A pool with no tables is already a known, reported state.** #1072 records
   that an empty pool is a silent infeasibility today. New rows created this way
   inherit that existing treatment rather than a new one.

## Consequences

**The two tabs cannot drift.** Table pools and Draw structure read and write the
same rows. A director who adds a pool card sees the pool count rise on the other
tab, and the reverse.

**A manual pool count is subject to the pool-set freeze.** Once a draw exists,
every fixture names its pool, so the set of pool identities is frozen. The
existing `_enforce_pool_set_frozen` guard already refuses the write. Typing a new
pool count into the Draw structure tab hits the same guard, and the tab states
the same reason. No second freeze rule is written.

**Lowering a manual pool count removes rows, which is destructive.** A director
who goes from six pools to four loses two reservations, with their windows and
their table selections. The app names what will go before it happens.

**A derived count cannot be saved as though it were chosen.** Saving with pool
size manual and pool count automatic stores the size and the modes. It does not
store eight. On the next load the count is recomputed, and against a changed
player cap it may recompute differently. That is what automatic means.

**The preview basis has to be honest, because the projection depends on it.** A
count derived against 16 invented players is a different count from one derived
against a 40-player cap. The tab labels which basis it used, and says plainly
when the 16 is a default rather than a cap.

**`Pool reservations` stays a fact in the preview.** It reads the row count. When
the projection exceeds it, the disagreement panel carries the difference, so the
fact line does not have to.

## Alternatives considered

**Store a pool count alongside the rows.** Rejected. Two numbers that mean the
same thing drift, and #1320's prompt names this outcome directly. It would also
need a rule for which one wins after a director edits pools on the other tab.

**Materialise derived pool rows eagerly.** Rejected. It creates reservations the
director never asked for, with no venue data, off a field size the app invented.
The ownership ADR forbids changing a director's structure without being asked,
and a silently created reservation is a bigger change than a silently changed
number.

**Take `max(rows, derived)` as the count, as the reference does.** Rejected as a
display convenience that hides the decision. It reports a pool count the event
cannot honour, and the extra pools have no identity, so the preview cannot say
which tables they use or when they play.

**Refuse to save while the projection exceeds the rows.** Rejected. This is a
disagreement, not an impossible competition. The director may be about to add the
rows on the next tab. Saving stays available, cutting does not.

**Let the cut create the missing pools.** Rejected. The cut is where pool
identities freeze. Minting a reservation at that moment gives it no window and no
tables, and the director has no chance to fix it before it is frozen.

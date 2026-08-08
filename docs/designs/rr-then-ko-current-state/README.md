# Round-robin then knockout: the current event editor

Reference screenshots for issue #1320, which asks a designer to rework how a
director controls a draw's structure. They record what the editor looks like
**before** that work, so the redesign has a fixed starting point.

Captured at 1280x800, on an owner-editable event whose draw is **not yet cut**.
Every control in frame is live. Once a draw exists the app freezes the draw type
and the pool set, and the editor shows a different, locked state.

## `current-rr-then-ko-draw-settings.png` — the Basics tab

A director sets: the event name, the format, the **draw type**, **qualifiers per
pool**, the player limit, the entry fee and the timezone. The event's own date
and window sit below the fold on the same tab.

A director does **not** set anything about the knockout stage. The bracket's
size is derived, as `pools x qualifiers per pool`, and is never typed in. There
is no control for the number of knockout rounds, for seeding, or for a
third-place match. Nothing on this tab states how many pools the event has.

## `current-rr-then-ko-table-pools.png` — the Table pools tab

A director adds a pool, names it, gives it a date and a window, and picks which
of the tournament's tables it reserves.

The **number of pools is the only way to set the number of groups**, and it is
implicit: a director who wants six groups adds six pools. Group *size* is never
entered. The cut divides the field across the pools, so size follows from the
field and the pool count.

A director does **not** set: which entrant plays in which pool, the pool order,
or the group size. The knockout stage has no card here, so it reserves no
tables and no window of its own.

## `current-draw-type-options.png` — the draw-type picker

The four formats a director can choose: round robin, single elimination,
round-robin then knockout, and swiss.

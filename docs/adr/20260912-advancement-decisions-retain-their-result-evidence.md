# Advancement decisions retain their result evidence

Status: Accepted for #1684, following the design interview. Part of #1669.

## Decision

An advancement decision records why an entry received one side of a downstream
fixture. Knockout winner advancement and group qualification use this history.
Swiss pairing, initial seeding and direct placement through an initial bye remain
draw construction and do not invent official-result evidence.

Each destination fixture side has at most one current decision. A decision names
the selected entry, its source fixture or group, the destination fixture and side,
and the rule version and relevant settings used. All entities belong to the same
event, with real foreign-key references and database-enforced ownership. Group
qualifiers have separate decisions for their respective seats even when they
share the same supporting results.

Normal advancement records its decision and evidence in the transaction that
fills the seat. Missing required official-result evidence fails that transaction;
it must not silently downgrade to unknown provenance. Group qualification retains
every official-result revision used to calculate the group's standings, including
matches the qualifier did not play. Known voided pairings are excluded from
scoring, following the existing group standings rule.

Evidence and rule settings are historical snapshots. A later result correction,
settings change, membership change or Account merge must not rewrite them.
Explicitly unknown provenance is supported for representative seeded history,
with an honest explanation and no fabricated result references. It is distinct
from verified evidence, and cannot be inferred merely from an empty evidence set.
There is no legacy-data backfill.

All advancement history, including explicitly unknown provenance, retains its
fixture, entry, event and tournament. Even without any match or recorded play,
such history prevents cutting or removing the draw and deleting its event or
tournament. Existing HTTP actions return a clear 409 conflict; MCP actions report
the same retention reason. Draws and parents without retained history continue
to follow their existing deletion rules.

## Current selection and stale evidence

“Current” identifies the decision governing the existing seat. “Stale” means a
supporting match now has a different current official revision or has been voided.
A correction from 3–0 to 3–1 makes the evidence stale even if the same entry would
still qualify. Staleness does not claim that the selected entry is incorrect;
recalculating eligibility is a separate concern.

A correction or void preserves the current decision, its original evidence, and
downstream participants. It does not automatically append a replacement, rerun
seating, or silently bless the old selection with new evidence. No new public
endpoint, screen, alert, or reconciliation workflow is enabled by this issue.

## Explicit replacement

The internal replacement operation requires an expected current decision, an
identified Account actor and a nonblank reason. A stale attempt writes nothing.
A successful replacement appends a decision after the current one and selects it
atomically; history cannot branch, rewind, be edited, or be deleted. Supporting
evidence remains attached to the decision that actually used it.

The current decision must agree with the destination seat. Once downstream play
has been recorded, replacement may reaffirm the same entry using new evidence,
but cannot substitute another entry. A conclusion that another player should
have qualified remains a discrepancy for a future reconciliation workflow.
Existing fixture and lineup retention rules continue to protect recorded play.

Before recorded play, an explicit change to an already materialized, pristine
match also updates that match side's participants in the same transaction. The
fixture seat and its upcoming match cannot disagree about who will play.
Participants are resolved to their canonical Players after Account merges;
historical entry membership and advancement evidence remain unchanged.

## Relationship to existing decisions

This extends ADR-0786/0788's idempotent advancement seam with durable decisions;
repeating completion/materialization must not create duplicate decisions. Their
fixture/match separation, absent bye fixtures and normal seating behavior remain.

The July 27 round-robin-then-knockout ADR's correction policy remains: corrected
standings do not re-seat previously selected qualifiers. Its empty-side-only
advancement now also records why each side was filled. This issue adds evidence
detection, not the untouched-bracket reseating policy that ADR deferred.

This fulfills the advancement-provenance portion deferred by the September 11
official-results ADR. Automatic reconciliation and public correction/replacement
workflows remain deferred. The September 6 fixture-ownership ADR still governs
which downstream facts become immutable after recorded play; advancement history
adds retention of the source, target and evidence it references.

## Verification and migration

Use successive red–green behavioral slices through backend operations for
knockout seating, full-group evidence, corrections and voids, missing-evidence
rollback, explicit unknown history and replacement. Exercise database ownership,
duplicate/current selection, immutable history and concurrent replacement rules
with direct SQL as well as backend regression tests. Include a corrected upstream
result after downstream play and same-entry reaffirmation.

Rewrite the disposable pre-beta Alembic baseline, verify actual fresh installs,
metadata parity and representative seeded scenarios. Do not build populated
legacy upgrade paths or reset unrelated databases. Existing HTTP/MCP contracts,
UI behavior, rating policy and deployments remain outside this change.

# Competition rules freeze at draw-cut

Status: Accepted for #1687 after the design interview. Team encounters and #1674
are excluded; singles/doubles rule distinctions do not enable new public flows.

## Freeze and interpretation

A successful draw-cut captures the effective competition rules for every stage
in one transaction. The retained draw revision owns this rules history. Future
match materialization, standings and advancement use its frozen rules, never
whichever editable event configuration or application defaults happen to be
current. A stage cannot adopt new rules after an earlier stage begins.

The snapshot includes the singles/doubles format, best-of, rated status, result
verification policy and retirement window, including effective defaults. It also
preserves the format-specific settings and interpretation of qualification,
pairing and tiebreaks. Interpretation versions are explicit: a deliberate change
to those semantics introduces a new version, while a bug fix can correct code
that failed to implement its declared version. Unknown versions are refused,
not interpreted using the latest implementation.

Names, descriptions, venue windows, table assignments and other scheduling
configuration retain their existing edit policies. Scheduling and schedule previews
use the effective frozen format and match length for a cut competition. These rules
do not freeze actual scores, calculated standings or results: corrections still
affect outcomes under the original rule interpretation.

## Revisions and editing

Every successful cut or recut creates a distinct rules revision, even when its
values equal those of the preceding revision. A failed cut leaves no partial
revision or changed binding. Uncutting retires the active draw binding and keeps
its rules history. Existing recut/uncut guards remain authoritative, including
their materialized-match and advancement-history restrictions; this does not
introduce a mid-competition rules-change operation.

The event's inline draw and match settings remain its owned planning values.
The API refuses actual event format, best-of or rated changes while a draw revision
is active, even before it has fixtures, with a 409 explaining that the draw must
first be removed. Unchanged values remain
accepted so saving an unrelated edit still works. Existing draw-format restrictions
continue. This tighter rules-edit policy is an intentional compatibility
change; silently accepting an edit that cannot affect the competition would
misrepresent a successful save.

## Match snapshots and ownership

Every match owns an immutable effective rules snapshot from creation, including
standalone matches. A tournament match copies its referenced competition rules
and retains provenance to them. A standalone match captures its supplied rules
and effective defaults. Later changes cannot rewrite either snapshot or replace
its reference to evade immutability.

Attaching an existing standalone match to a fixture preserves its original
snapshot and requires agreement with the fixture's frozen rules. The fixture
retains the competition reference; attachment cannot rewrite the match's rules
or falsely attribute its original creation to that competition.
A match claiming tournament provenance must belong to a fixture in that revision.

PostgreSQL enforces immutability and real, scope-correct references as well as
application validation. Competition rules belong to their event/draw scope and
cannot be shared across unrelated competitions or moved to another owner. Rules
history does not transfer during Account or Player merges; existing tournament
ownership changes preserve the competition and its history.

Revisions remain while their event exists. Rules alone do not add a new event
deletion restriction: existing history-retention policies decide whether the
event can be deleted. Permitted event deletion can remove unused rules history;
references from surviving matches must remain protected.

## Amended decisions

This extends [owned inline draw settings](20260906-event-draw-settings-are-owned-inline-values.md):
those values remain editable planning configuration, while the rules used by a
cut competition have a separate immutable lifecycle. It supersedes that ADR's
blanket preservation of match-settings edit behavior.

This refines [stage strategy dispatch](20260815-an-events-stages-are-rows-and-a-composite-draw-type-is-a-template.md),
decisions 6 and 7: stage execution and qualifier-flow derivation use the frozen
version and settings of the draw, rather than current mutable configuration.
Stages are still cut together and qualification remains derived.

This supersedes the current-event-settings and implicit-default copying in
[match materialization](0788-materialize-at-go-live-and-results-are-a-per-draw-type-strategy.md).
Materialization timing and the shared match result lifecycle remain unchanged.
The [retained draw revision](20260911-registration-outlives-draw-participation.md)
remains the identity of a draw attempt; rules do not introduce a competing draw
identity or restore retired participation.

## Verification and migration

Develop in incremental red/green behavioral slices through the existing API and
backend interfaces. Direct SQL is also an integrity interface: verify immutable
values and references, scope ownership, retained revisions and permitted parent
deletion against actual Alembic migrations. Cover later-round materialization
after planning/default changes, versioned interpretation, successful and failed
recuts, unchanged-value saves and concurrent settings edits versus draw-cut.

Rewrite the disposable pre-beta baseline and verify fresh installs, schema
parity, representative seeds and backend regressions. No legacy backfill,
populated-database upgrade path, new UI, general-purpose rules engine or
deployment belongs to this change.

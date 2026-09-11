# Official results have immutable revisions

Status: Accepted for #1682, following the design interview. Part of #1669.

## Decision

Participant proposals and official results have separate histories. An official
revision contains a complete, decisive score snapshot, its match, a per-match
revision number, its predecessor, database-recorded time and resolution provenance.
Each match has at most one root and one linear chain. Its current official result
is always the latest revision, selected atomically by the database when appending.
History cannot be updated or deleted, including the tail. A match with official
history cannot be hard-deleted. Normal retention remains enforced even though
explicit disposable pre-beta resets are permitted until #1670.

There are four resolution methods:

- **Opponent acceptance:** the opposing participant's actual Account and recorded
  proposal acceptance. Submission alone never implies opponent consent.
- **Timeout:** system finalization after the retirement deadline, with no human
  accepting actor. Retain the deadline and policy version (`retirement_window_v1`).
- **Immediate finalization:** today's solo/unrated participant submission rules,
  naming the submitting Account, without manufacturing another acceptance.
- **Administrator ruling:** a tournament owner or active director's Account,
  reason, tournament and the ownership revision or director grant used. Retain
  that evidence after transfer, revocation or Account merge; historical actors
  never change. The initial ownership revision is zero and is explained by the
  tournament's immutable creator attribution; later revisions have transfer history.

## Corrections and restoration

The internal correction operation requires the expected current revision and a
nonblank reason. The author supplies exactly one score source: a complete score,
a same-match proposal to adopt, or a same-match official revision to restore.
Adopting a proposal copies its exact score, including when the proposal has been
superseded. It never changes the proposal's acceptance. A ruling with different
scores is a direct ruling with its own explanation and no adoption reference.

Restoration copies the older **score**, not its historical authorship, time or
resolution method. It appends a new administrator ruling after the latest revision,
retaining a link to the restored revision. Nothing moves the current pointer back
and nothing branches. Correcting a correction follows the same operation.

Only an administrator ruling can follow an official revision. Participants cannot
replace a ruling through acceptance or timeout. Completed matches retain today's
public proposal/acceptance restrictions. Concurrent corrections have a definite
order: the losing stale attempt creates no revision and must be reviewed against
the new current result before resubmission. Direct SQL writers are also serialized;
stale repeatable-read writes fail rather than branching.

Administrator corrections are limited to tournament matches. Owners and directors
may rule on matches they played in, but their ordinary participant submissions
still follow participant rules. Authority is rechecked after acquiring the shared
Account/tournament/event/match lock order. Revocation or transfer that wins that
order denies the later operation; a ruling that wins remains valid history.

The correction and its displayed score/winner commit together. The match remains
completed with its original completion time. A correction does not rerun initial
completion: rating recalculation/provenance belongs to #1683, and advancement
reconciliation/provenance to #1684. It does not change downstream participants or
apply ratings twice. These internal operations do not enable a public correction
workflow ahead of those dependent capabilities.

## Voiding and compatibility

Voiding is a separate administrator action with a nonblank reason and authority
evidence, not an undecided score revision. It preserves the current official score
and all history while excluding the match from active outcomes. Further score
corrections are refused while voided; reinstatement/reopening is outside this issue.
The existing system-applied self-play collision void during Account merge remains
a separate compatibility rule from ADR-0013. It does not invent an administrator
actor or reason. Existing rating removal on void remains until the rating redesign.

Existing non-playing director submissions and acceptance of a player's proposal
remain authoritative. They record administrator rulings with the explicit system
explanation “Result recorded by tournament director”; the current screens collect
no explanation. New internal corrections require a supplied reason. Existing
notifications and score displays remain compatible. No new HTTP/MCP endpoint,
UI control, public override workflow or deployment is introduced.

## Amended decisions

This supersedes ADR-0008's description of retirement as human **consent by lapse**
and its use of the accepting participant's identity for automation. Its deadline,
reminder, notification and first-completion behavior remain. Retirement is an
explicit timeout resolution, with no known human acceptance recorded.

This refines the self-accept terminology in the September 2 result-notification
ADR: immediate and director finalization keep their notification behavior but no
longer write proposal acceptance on behalf of the poster/director. It extends the
September 6 proposal-history ADR with a separate official chain; proposal snapshots,
recorded acceptance, Account actors and the Player-merge exception remain intact.
The September 7 authority ADR continues to govern grants and ownership history.

## Verification

Exercise the internal result interface against actual fresh Alembic installations:
all four resolutions, corrections/restoration, exact adoption, stale concurrent
writers, revoked authority and voids. Direct SQL tests cover immutable snapshots,
root/predecessor rules, scoped references, actor/reason/authority constraints and
invalid scores. A ruling has at most one proposal/restoration source link.
Correction appends synchronize the canonical games and winner inside the database
transaction, including for direct SQL writers. Retirement eligibility uses the
same database clock that records timeout revisions, including sweep selection.
A deferred constraint requires first official results to complete their match by
commit; every official append synchronizes the canonical score. Closed matches
reject new proposals and late consent. Opponent consent cannot name the proposing
Account, and immediate finalization requires a managed participant.

Rated casual match creation requires the opponent to have a managing Account, so
unclaimed tournament entrants cannot be targeted for uncontestable rating claims.
Existing unrated play remains supported. Once a contestable match has been created,
a later loss of the owing Player's account grant does not prevent system timeout.

Verify metadata parity and downgrade/reinstall. Seed representative
accepted/corrected histories through real backend operations, with honest actors
and reasons, rather than backfilling disposable pre-beta data. Existing backend
regressions verify unchanged public score behavior.

"""Combine same-person Players, transfer authority and tombstone the source Account.

Historical actors retain their Account references. Sporting collisions use the
existing reconciliation rules; callers enqueue rating recomputation after commit.
Session tokens remain on the Account tombstone for session-ended detection.
"""

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, cast

from sqlalchemy import CursorResult, delete, exists, or_, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.match_voiding import void_match
from app.models import (
    AccountPlayer,
    DeviceToken,
    EmailIntent,
    EmailToken,
    FirstSignInIntent,
    LeagueMembership,
    Match,
    MatchGame,
    MatchLineup,
    MatchResult,
    MatchSide,
    MatchSidePlayer,
    Notification,
    NotificationChannelSetting,
    NotificationPreference,
    Player,
    RatingHistory,
    ScheduleSolveTrigger,
    Tournament,
    TournamentEntry,
    TournamentEntryRegistration,
    TournamentEntryStatus,
    TournamentEvent,
    TournamentEventStage,
    TournamentFixture,
    User,
    UserLeagueRating,
    UserRole,
)
from app.models.tournament_entry_participation import WithdrawalReason
from app.schedule_solves import request_solve, tournament_has_drawn_event
from app.tournament_authority import lock_merge_tournaments, merge_authority
from app.tournament_draws import draw_has_play, uncut_draw
from app.tournament_participation import close_registration

# Bind the active state from the enum in reconciliation queries. The database
# independently enforces scoped participation through entry membership.
_ACTIVE_ENTRY_STATUS: str = TournamentEntryStatus.entered.value


@dataclass(frozen=True)
class _SelfPlayCollision:
    """The rated self-play collisions found for one merge (see ADR-0013).

    ``match_ids`` are the rated matches on which the ephemeral and verified
    users sat on opposite sides — the matches to void. ``from_side_ids`` are the
    ephemeral user's sides on those matches — the sides to *exclude* from the
    prune so they survive player-less rather than being half-deleted.
    """

    match_ids: frozenset[uuid.UUID]
    from_side_ids: frozenset[uuid.UUID]


@dataclass(frozen=True)
class MergeSummary:
    #: Distinct matches the ephemeral user played that now belong to the
    #: survivor AND still count — both cleanly re-pointed rows and ones dropped
    #: by the belt-and-braces delete because the survivor already sat on that
    #: match. EXCLUDES self-play collisions that were voided (see
    #: ``matches_voided``): those transferred to the survivor but no longer
    #: count, so counting them would make the "we brought your N matches with
    #: you" toast claim a match that was just voided.
    matches_moved: int
    #: Rated self-play collisions voided by this merge (ADR-0013). Internal to
    #: the merge primitive — the caller uses it to keep ``matches_moved``
    #: honest, and it is deliberately NOT surfaced on the ``MergeSummary`` the
    #: session response exposes (``app.schemas.session``), to avoid drifting the
    #: generated OpenAPI clients for a number the FE doesn't render.
    matches_voided: int


class _ConcurrentEntryCollision(Exception):
    """Re-run a merge whose initial entry scan missed a concurrent registration."""


class EntryMergeConflict(ValueError):
    """Duplicate sporting histories need resolution before identity reconciliation."""

    def __init__(
        self,
        source_entry_id: uuid.UUID,
        target_entry_id: uuid.UUID,
        stage_id: uuid.UUID,
    ) -> None:
        self.source_entry_id = source_entry_id
        self.target_entry_id = target_entry_id
        self.stage_id = stage_id
        super().__init__(
            f"Entries {source_entry_id} and {target_entry_id} have recorded play "
            f"in the same stage {stage_id}; director resolution is required."
        )


async def merge_user(
    db: AsyncSession,
    *,
    from_user_id: uuid.UUID,
    to_user_id: uuid.UUID,
) -> MergeSummary:
    """Confirm two primary players are the same person and transfer authority.

    Account tombstones retain original authorship. Sporting histories combine only
    through this explicit operation. Existing public flows merge an unconfirmed
    guest into a live destination; multi-manager reconciliation is not enabled.
    Runs in the caller's transaction.
    """
    if from_user_id == to_user_id:
        raise ValueError("Cannot merge an account into itself")
    accounts = (
        await db.scalars(
            select(User)
            .where(User.id.in_([from_user_id, to_user_id]))
            .order_by(User.id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    ).all()
    by_id = {account.id: account for account in accounts}
    source, target = by_id.get(from_user_id), by_id.get(to_user_id)
    if source is None or target is None:
        raise ValueError("Both accounts must exist")
    if source.merged_into_user_id is not None or target.merged_into_user_id is not None:
        raise ValueError("Cannot merge a tombstoned account")
    source_player, target_player = source.primary_player, target.primary_player
    source_display_name = source.username
    if len(source.player_grants) > 1:
        raise ValueError("Merging accounts that manage multiple players is not enabled")
    await lock_merge_tournaments(db, source_id=from_user_id, target_id=to_user_id)
    summary = MergeSummary(matches_moved=0, matches_voided=0)
    if (
        source_player is not None
        and target_player is not None
        and source_player.id != target_player.id
    ):
        other_manager = await db.scalar(
            select(AccountPlayer.account_id)
            .where(
                AccountPlayer.player_id == source_player.id,
                AccountPlayer.account_id != source.id,
            )
            .limit(1)
        )
        if other_manager is not None:
            raise ValueError("Merging a player with other managers is not enabled")
        source_player_id, target_player_id = source_player.id, target_player.id
        for attempt in range(3):
            try:
                async with db.begin_nested():
                    summary = await _merge_players(
                        db,
                        from_user_id=source_player_id,
                        to_user_id=target_player_id,
                        actor_account_id=to_user_id,
                    )
                    # Registration may commit after collision discovery but before
                    # the Player update takes its event locks. Validate here while
                    # those locks are held, so reconciliation can retry atomically
                    # against the newly visible entry instead of failing at COMMIT.
                    collision = await db.scalar(
                        text(
                            """
                            WITH RECURSIVE identities(id) AS (
                                SELECT CAST(:player AS uuid)
                                UNION SELECT p.id FROM players p
                                    JOIN identities i ON p.merged_into_player_id = i.id
                            )
                            SELECT EXISTS (
                                SELECT e.event_id FROM identities i
                                JOIN tournament_entry_members m ON m.player_id = i.id
                                JOIN tournament_entries e ON e.id = m.entry_id
                                JOIN tournament_events ev ON ev.id = e.event_id
                                WHERE m.left_at IS NULL AND e.status = 'entered'
                                    AND NOT ev.allow_multiple_entries_per_player
                                GROUP BY e.event_id HAVING count(DISTINCT e.id) > 1
                            )
                            """
                        ),
                        {"player": target_player_id},
                    )
                    if collision:
                        raise _ConcurrentEntryCollision()
                break
            except _ConcurrentEntryCollision:
                if attempt == 2:
                    raise
    elif source_player is not None and target_player is None:
        existing = next(
            (
                grant
                for grant in target.player_grants
                if grant.player_id == source_player.id
            ),
            None,
        )
        if existing is not None:
            existing.is_primary = True
        else:
            target.player_grants.append(
                AccountPlayer(player=source_player, is_primary=True)
            )
    await merge_authority(db, source_id=from_user_id, target_id=to_user_id)
    source.display_name = source_display_name
    source.player_grants.clear()
    await db.flush()
    await _transfer_account(db, from_user_id=from_user_id, to_user_id=to_user_id)
    return summary


async def _merge_players(
    db: AsyncSession,
    *,
    from_user_id: uuid.UUID,
    to_user_id: uuid.UUID,
    actor_account_id: uuid.UUID,
) -> MergeSummary:
    """Combine sporting records under the existing collision and rating rules."""
    # The caller holds the sorted union of sporting and authority tournaments.
    collision = await _self_play_collision(
        db, from_user_id=from_user_id, to_user_id=to_user_id
    )

    matches_moved = await _repoint_match_side_players(
        db, from_user_id=from_user_id, to_user_id=to_user_id
    )

    await _resolve_entry_collisions(
        db,
        from_user_id=from_user_id,
        to_user_id=to_user_id,
        actor_account_id=actor_account_id,
    )
    # Membership records retain the originally registered Player. The singles
    # projection resolves its explicit same-person merge chain after tombstoning.

    # user_league_ratings / league_memberships both have UNIQUE(league_id,
    # user_id). Re-point only where the verified user has no row in that
    # league; the leftover ephemeral rows are dropped explicitly below.
    # Don't try to merge JSONB rating state — a rating recompute against the
    # merged match list is the only correct reconciliation.
    await db.execute(
        text(
            """
            UPDATE user_league_ratings AS ulr
            SET user_id = :to_id
            WHERE ulr.user_id = :from_id
              AND NOT EXISTS (
                SELECT 1 FROM user_league_ratings other
                WHERE other.user_id = :to_id
                  AND other.league_id = ulr.league_id
              )
            """
        ),
        {"from_id": from_user_id, "to_id": to_user_id},
    )
    await db.execute(
        text(
            """
            UPDATE league_memberships AS lm
            SET user_id = :to_id
            WHERE lm.user_id = :from_id
              AND NOT EXISTS (
                SELECT 1 FROM league_memberships other
                WHERE other.user_id = :to_id
                  AND other.league_id = lm.league_id
              )
            """
        ),
        {"from_id": from_user_id, "to_id": to_user_id},
    )

    # match_side_players is RESTRICT, so any rows that didn't re-point would
    # block the final user delete. Re-point should always cover them; this is
    # a belt-and-braces drop in case the impossible collision ever fires.
    # Capture the sides the ephemeral user sat on *before* dropping the rows,
    # so we can prune any that the drop leaves playerless (see below).
    ephemeral_side_ids = (
        (
            await db.execute(
                select(MatchSidePlayer.match_side_id).where(
                    MatchSidePlayer.user_id == from_user_id
                )
            )
        )
        .scalars()
        .all()
    )
    dropped_side_players = await db.execute(
        delete(MatchSidePlayer).where(MatchSidePlayer.user_id == from_user_id)
    )
    # A row dropped here (see the collision case below) is still a match the
    # ephemeral user played, now solely under the verified account — it counts
    # as moved just like the rows the UPDATE re-pointed above. Without this,
    # `matches_moved` (and the "we brought your matches with you" toast)
    # silently under-reports for that collision case. The rated collisions we
    # VOID below are the exception — they are subtracted back out at the return.
    matches_moved += cast(CursorResult[Any], dropped_side_players).rowcount or 0
    # The collision case is self-play across two guest sessions (both sides of
    # the same match were the same real person). The NOT EXISTS guard skipped
    # re-pointing the ephemeral side because the verified user was already
    # there; the DELETE above then removed that MatchSidePlayer, leaving a
    # playerless MatchSide.
    #
    # For an UNRATED collided match we prune that now-empty side, so it doesn't
    # surface as "No opponent" / "vs Guest" in match history — the match never
    # counted, so there is nothing to preserve. For a RATED collided match we
    # must NOT prune: pruning half-deletes it (the match keeps
    # ``status == completed`` + ``affects_rating`` but loses a side, and the
    # rating cascade then skips it, stranding the survivor's inflated rating
    # history — issue #750). Instead we leave the side player-less — the same
    # structural shape a solo match's sentinel side already has — and void the
    # match below. So exclude the rated-collided sides from the prune.
    #
    # Scope the prune to the sides the ephemeral user actually sat on — a global
    # ``no players`` filter would also wipe the intentional player-less
    # "sentinel" side that every opponent-less (solo) match carries by design.
    prunable_side_ids = set(ephemeral_side_ids) - collision.from_side_ids
    if prunable_side_ids:
        await db.execute(
            delete(MatchSide).where(
                MatchSide.id.in_(prunable_side_ids),
                ~MatchSide.players.any(),
            )
        )
    # Void the rated collided matches: transfer them wholly to the survivor
    # (already done — the survivor's MatchSidePlayer, creator/result/tournament
    # authorship, and rating_history authorship all re-point above), then mark
    # them ``voided`` and delete their rating_history for BOTH users. The
    # survivor's own rating_history row for a collided match survives every
    # DELETE above (it is keyed on ``user_id == to_user_id``, and the cascade
    # skips a one-sided match), so ``void_match``'s by-``match_id`` delete is the
    # only thing that removes it. ``void_match`` does not commit.
    collided_matches: list[Match] = []
    if collision.match_ids:
        collided_matches = list(
            (await db.execute(select(Match).where(Match.id.in_(collision.match_ids))))
            .scalars()
            .all()
        )
        for match in collided_matches:
            await void_match(db, match)
    await db.execute(delete(RatingHistory).where(RatingHistory.user_id == from_user_id))
    await db.execute(
        delete(UserLeagueRating).where(UserLeagueRating.user_id == from_user_id)
    )
    await db.execute(
        delete(LeagueMembership).where(LeagueMembership.user_id == from_user_id)
    )
    # Recording the Player merge atomically repoints proposal representation
    # through the database trigger; original Account actors remain immutable.
    await db.execute(
        update(Player)
        .where(Player.id == from_user_id)
        .values(merged_into_player_id=to_user_id, merged_at=datetime.now(UTC))
    )
    # Advance only after the sporting identity is reconciled: a newly ready
    # fixture must materialize against the merged Player, not the old identity.
    if collided_matches:
        from app.tournament_advancement import on_match_completed

        for match in collided_matches:
            await on_match_completed(db, match)
    # A voided rated collision was dropped by the belt-and-braces delete above
    # (its guest MatchSidePlayer was never re-pointed), so it got added into
    # `matches_moved`. But we just voided it — it no longer counts. Subtract the
    # voided collisions so `matches_moved` reflects only matches that carried
    # over and still count. Every collided match's guest side is dropped by that
    # delete exactly once (UNIQUE(match_id, user_id)), so `len(match_ids)` is the
    # exact overcount.
    matches_voided = len(collision.match_ids)
    matches_moved -= matches_voided

    return MergeSummary(matches_moved=matches_moved, matches_voided=matches_voided)


async def _transfer_account(
    db: AsyncSession,
    *,
    from_user_id: uuid.UUID,
    to_user_id: uuid.UUID,
) -> None:
    # device_tokens.token is UNIQUE, so re-point only the guest's tokens the
    # survivor doesn't already hold; the rare collision (same physical device
    # registered under both users) is dropped with the rest below.
    await db.execute(
        text(
            """
            UPDATE device_tokens AS dt
            SET user_id = :to_id
            WHERE dt.user_id = :from_id
              AND NOT EXISTS (
                SELECT 1 FROM device_tokens other
                WHERE other.user_id = :to_id
                  AND other.token = dt.token
              )
            """
        ),
        {"from_id": from_user_id, "to_id": to_user_id},
    )

    # Carry the guest's granted roles onto the survivor rather than dropping
    # them: a role a moderator handed the ephemeral session (or that the guest
    # earned) is a real grant we must not silently lose when the guest signs in.
    # ``user_roles`` PKs on (user_id, role_id), so re-point only the roles the
    # survivor doesn't already hold — a role BOTH users have would collide on
    # that key. The leftover (already-held) ephemeral rows are dropped by the
    # tombstone cleanup below.
    await db.execute(
        text(
            """
            UPDATE user_roles AS ur
            SET user_id = :to_id
            WHERE ur.user_id = :from_id
              AND NOT EXISTS (
                SELECT 1 FROM user_roles other
                WHERE other.user_id = :to_id
                  AND other.role_id = ur.role_id
              )
            """
        ),
        {"from_id": from_user_id, "to_id": to_user_id},
    )

    # We tombstone rather than DELETE the user, so the rows that used to ride
    # ``ON DELETE CASCADE`` must be dropped explicitly. Order doesn't matter —
    # none of these reference each other. Keep the guest's *session* tokens so
    # its cookie still resolves to this (now-tombstoned) row. The role re-point
    # above already moved every grant the survivor lacked; this clears any that
    # stayed behind as duplicates so the tombstone ends with no roles.
    await db.execute(delete(UserRole).where(UserRole.user_id == from_user_id))
    await db.execute(delete(DeviceToken).where(DeviceToken.user_id == from_user_id))
    # A guest's in-app notifications and preference overrides are throwaway —
    # drop them rather than carrying a tombstoned guest's feed onto the survivor.
    await db.execute(delete(Notification).where(Notification.user_id == from_user_id))
    await db.execute(
        delete(NotificationChannelSetting).where(
            NotificationChannelSetting.user_id == from_user_id
        )
    )
    await db.execute(
        delete(NotificationPreference).where(
            NotificationPreference.user_id == from_user_id
        )
    )
    await db.execute(
        delete(EmailToken).where(
            EmailToken.user_id == from_user_id,
        )
    )

    await db.execute(delete(EmailIntent).where(EmailIntent.user_id == from_user_id))
    await db.execute(
        delete(FirstSignInIntent).where(FirstSignInIntent.user_id == from_user_id)
    )

    # Auth0's namespaced LoginIdentity follows the existing move-or-clear policy:
    # retain the destination binding when present, otherwise transfer the source's.
    # Account.auth0_sub projects the configured issuer's identity relation.
    ephemeral_agent_access = (
        (
            await db.execute(
                select(
                    User.auth0_sub,
                    User.agent_access_linked_at,
                    User.agent_access_revoked_at,
                ).where(User.id == from_user_id)
            )
        )
        .tuples()
        .one_or_none()
    )
    # A missing row leaves every branch below a no-op, as the old
    # ``scalar_one_or_none`` read did — the caller's "``from_user_id`` exists"
    # invariant is enforced by the tombstone UPDATE, not here.
    freed, freed_linked_at, ephemeral_revoked_at = ephemeral_agent_access or (
        None,
        None,
        None,
    )
    if freed is not None:
        # Null the ephemeral FIRST (freeing the value from the unique index) so the
        # survivor UPDATE can adopt it without the two rows momentarily colliding —
        # the constraint is checked per statement, not deferred. The survivor's
        # ``auth0_sub IS NULL`` guard carries the "adopt only where the survivor has
        # none" rule declaratively: if the survivor already holds a binding, its
        # own link stands and the ephemeral's is simply dropped.
        #
        # ``agent_access_linked_at`` is a fact ABOUT THE BINDING — "when this Auth0
        # identity became linked to this account", the settings page's "Connected
        # <date>". So it goes exactly where the binding goes: cleared off the
        # tombstone (which no longer holds the link the stamp describes) and, in
        # the same guarded statement that adopts the ``sub``, carried onto the
        # survivor. Adopting the binding without the stamp is what left a survivor
        # reading ``connected`` with no date. When the survivor already holds its
        # own binding the guard fails and both columns stay its own, which is right
        # — its stamp describes the link it kept.
        source = await db.get(User, from_user_id)
        target = await db.get(User, to_user_id)
        if source is None or target is None:
            raise ValueError("Merge accounts disappeared")
        source.auth0_sub = None
        source.agent_access_linked_at = None
        await db.flush()
        if target.auth0_sub is None:
            target.auth0_sub = freed
            target.agent_access_linked_at = freed_linked_at

    # ``agent_access_revoked_at`` — the player's own "I switched agent access off"
    # — is NOT a fact about the binding, and deliberately does not ride the block
    # above. Disconnect *clears* ``auth0_sub`` as it stamps this column
    # (``app.agent_access.disconnect_agent_access``), so a revoked account has no
    # binding to move: gating the carry on a moved binding would make it dead code
    # in exactly the case it exists for. It is a per-user, sticky fact, so the
    # merge takes the UNION of the two accounts' revocations — set on the survivor
    # if either party had it set.
    #
    # Fail-closed in both directions, which is the whole point:
    #   * ephemeral revoked, survivor not → the survivor inherits the revocation.
    #     Without this the merge silently hands over a usable agent connection the
    #     player had switched off: the MCP transport only refuses a *revoked* user,
    #     and ``resolve_or_provision_user`` re-matches the freed Auth0 identity onto
    #     the survivor by verified email the moment the next token arrives.
    #   * survivor already revoked → the ``IS NULL`` guard makes adopting anything
    #     (a binding, an ephemeral's later revocation stamp) unable to un-revoke it,
    #     and leaves the survivor's own moment intact rather than rewriting it.
    #
    # The cost is a false positive: a guest who hit disconnect (the endpoint is
    # open to guests, though a guest can never connect) switches off the account it
    # merges into. That is the right direction to fail — the error the other way is
    # silent, and is a re-grant of revoked access — but the remedy is NOT always
    # one click. ``resolve_agent_access_state`` ranks ``gated`` above ``revoked``,
    # so a survivor without the ``mcp.access`` grant reads "Not enabled" and is
    # offered no re-allow control at all: for them the stamp is invisible and stays
    # until an operator grants the permission. Since most survivors do not hold the
    # beta bundle, that is the common case, not the edge one. The
    # tombstone KEEPS its own stamp: revocation is a historical fact about that
    # account, its session cookie still resolves to the row, and nothing in this
    # merge is entitled to un-revoke an account.
    if ephemeral_revoked_at is not None:
        await db.execute(
            update(User)
            .where(User.id == to_user_id, User.agent_access_revoked_at.is_(None))
            .values(agent_access_revoked_at=ephemeral_revoked_at)
        )

    # Tombstone: keep the row (and its session tokens) so the guest's cookie
    # still resolves and the auth layer can report the merge.
    await db.execute(
        update(User)
        .where(User.id == from_user_id)
        .values(merged_into_user_id=to_user_id, merged_at=datetime.now(UTC))
    )
    await db.flush()


async def _resolve_entry_collisions(
    db: AsyncSession,
    *,
    from_user_id: uuid.UUID,
    to_user_id: uuid.UUID,
    actor_account_id: uuid.UUID,
) -> None:
    """Resolve duplicate entries while retaining their original sporting history.

    Recorded play takes precedence over account destination. Duplicate play in
    the same stage refuses the merge before the nested transaction can commit.
    Supersession preserves original membership and closes registration and stage
    participation with the acting Account's reconciliation provenance.

    A changed active field retires its unplayed draw; played draws and valid
    draws unaffected by historical duplicates remain intact. Scheduling requests
    coalesce per tournament under the caller's parent locks.
    """
    params: dict[str, Any] = {
        "from_id": from_user_id,
        "to_id": to_user_id,
        "active": _ACTIVE_ENTRY_STATUS,
    }

    # Read before withdrawal removes the active collision from these queries.
    collisions = (
        (
            await db.execute(
                text(
                    """
                    WITH RECURSIVE identities(id) AS (
                        SELECT CAST(:from_id AS uuid)
                        UNION SELECT CAST(:to_id AS uuid)
                        UNION SELECT p.id FROM players p
                            JOIN identities i ON p.merged_into_player_id = i.id
                    ), candidate_entries AS MATERIALIZED (
                        SELECT DISTINCT m.entry_id FROM identities i
                        JOIN tournament_entry_members m ON m.player_id = i.id
                        WHERE m.left_at IS NULL
                    ), projected_entries AS MATERIALIZED (
                        SELECT e.id, e.event_id, entry_single_player(e.id) AS player_id
                        FROM candidate_entries c
                        JOIN tournament_entries e ON e.id = c.entry_id
                        JOIN tournament_events ev ON ev.id = e.event_id
                        WHERE e.superseded_by_entry_id IS NULL
                            AND NOT ev.allow_multiple_entries_per_player
                    )
                    SELECT guest.event_id, guest.id, survivor.id
                    FROM projected_entries AS guest
                    JOIN projected_entries AS survivor
                      ON survivor.event_id = guest.event_id
                     AND survivor.player_id = :to_id
                    WHERE guest.player_id = :from_id
                    """
                ),
                params,
            )
        )
        .tuples()
        .all()
    )
    collided_event_ids = {row[0] for row in collisions}
    if not collided_event_ids:
        return
    played_stages: dict[uuid.UUID, set[uuid.UUID]] = {}
    entry_ids = {entry_id for row in collisions for entry_id in row[1:]}
    recorded_fixtures = (
        (
            await db.execute(
                select(
                    TournamentFixture.entry_a_id,
                    TournamentFixture.entry_b_id,
                    TournamentFixture.stage_id,
                )
                .execution_options(include_draw_history=True)
                .where(
                    or_(
                        TournamentFixture.entry_a_id.in_(entry_ids),
                        TournamentFixture.entry_b_id.in_(entry_ids),
                    ),
                    or_(
                        TournamentFixture.winner_entry_id.is_not(None),
                        exists(
                            select(MatchLineup.id).where(
                                MatchLineup.match_id == TournamentFixture.match_id
                            )
                        ),
                        exists(
                            select(MatchGame.id).where(
                                MatchGame.match_id == TournamentFixture.match_id
                            )
                        ),
                        exists(
                            select(MatchResult.id).where(
                                MatchResult.match_id == TournamentFixture.match_id
                            )
                        ),
                    ),
                )
            )
        )
        .tuples()
        .all()
    )
    for entry_a_id, entry_b_id, stage_id in recorded_fixtures:
        for entry_id in (entry_a_id, entry_b_id):
            if entry_id is not None:
                played_stages.setdefault(entry_id, set()).add(stage_id)
    for _, source_id, target_id in collisions:
        common = played_stages.get(source_id, set()) & played_stages.get(
            target_id, set()
        )
        if common:
            raise EntryMergeConflict(source_id, target_id, min(common))
    entries = {
        entry.id: entry
        for entry in await db.scalars(
            select(TournamentEntry)
            .where(TournamentEntry.id.in_(entry_ids))
            .execution_options(populate_existing=True)
        )
    }
    entries_by_event: dict[uuid.UUID, set[uuid.UUID]] = {}
    for event_id, source_id, target_id in collisions:
        entries_by_event.setdefault(event_id, set()).update((source_id, target_id))
    # Preserve recorded play first, then current registration, then the existing
    # target preference. Every historical duplicate has one permanent destination.
    collisions = []
    for event_id, candidates in entries_by_event.items():
        retained_id = min(
            candidates,
            key=lambda entry_id: (
                not bool(played_stages.get(entry_id)),
                entries[entry_id].status is not TournamentEntryStatus.entered,
                entries[entry_id].user_id != to_user_id,
                entries[entry_id].created_at,
                entry_id,
            ),
        )
        collisions.extend(
            (event_id, duplicate_id, retained_id)
            for duplicate_id in sorted(candidates - {retained_id})
        )
    source_entry_ids = {row[1] for row in collisions}
    params["source_entry_ids"] = list(source_entry_ids)
    params["target_entry_ids"] = list({row[2] for row in collisions})

    # Parent locks serialize reconciliation with registration, draws and play.
    # Re-locking the caller's ordered tournament set is harmless.
    event_tournament_ids: dict[uuid.UUID, uuid.UUID] = dict(
        (
            await db.execute(
                select(TournamentEvent.id, TournamentEvent.tournament_id).where(
                    TournamentEvent.id.in_(collided_event_ids)
                )
            )
        )
        .tuples()
        .all()
    )
    await db.execute(
        select(Tournament.id)
        .where(Tournament.id.in_(sorted(set(event_tournament_ids.values()))))
        .order_by(Tournament.id)
        .with_for_update()
    )

    # Resolving an already-withdrawn duplicate does not change a valid field.
    changed_field_event_ids = {
        event_id
        for event_id, duplicate_id, _ in collisions
        if entries[duplicate_id].status is TournamentEntryStatus.entered
    }
    played_event_ids = {
        event_id
        for event_id in changed_field_event_ids
        if await draw_has_play(db, event_id)
    }
    unplayed_event_ids = changed_field_event_ids - played_event_ids

    # Which tournaments this collision's mutations owe a re-solve. Filled by
    # both arms below, deduped so a merge that touches two events of one
    # tournament enqueues at most one solve for it (``request_solve`` would
    # coalesce the duplicate anyway; no reason to make it).
    solve_tournament_ids: set[uuid.UUID] = set()

    # Recorded play chooses the durable survivor, not whether registration is
    # still open. Carry an active duplicate's registration onto a withdrawn
    # survivor with a new period; its ended participation and withdrawal history
    # remain unchanged. Do this before closing duplicates so priority can still
    # follow their reconciled registration periods.
    reactivated_entry_ids = {
        retained_id
        for _, duplicate_id, retained_id in collisions
        if entries[retained_id].status is TournamentEntryStatus.withdrawn
        and entries[duplicate_id].status is TournamentEntryStatus.entered
    }
    if reactivated_entry_ids:
        db.add_all(
            TournamentEntryRegistration(
                entry_id=entry_id, registered_by_account_id=actor_account_id
            )
            for entry_id in sorted(reactivated_entry_ids)
        )
        await db.execute(
            update(TournamentEntry)
            .where(TournamentEntry.id.in_(reactivated_entry_ids))
            .values(status=TournamentEntryStatus.entered)
        )

    # (1) Copy metadata between the captured collision entries while both are
    # still registered. A played source can survive its target duplicate; the
    # withdrawal below must not erase that duplicate from this transfer.
    await db.execute(
        text(
            """
            UPDATE tournament_entries AS survivor
            SET created_at = LEAST(survivor.created_at, guest.created_at),
                seed = COALESCE(survivor.seed, guest.seed)
            FROM tournament_entries AS guest
            WHERE survivor.id = ANY(:target_entry_ids)
              AND survivor.status = :active
              AND guest.id = ANY(:source_entry_ids)
              AND guest.status = :active
              AND guest.event_id = survivor.event_id
              AND guest.event_id IN (
                SELECT id FROM tournament_events
                WHERE NOT allow_multiple_entries_per_player
              )
            """
        ),
        params,
    )

    if played_event_ids:
        # The withdrawal arm's solve gate, read while the guest's entries are
        # still ``entered``: withdraw_from_event's doctrine, in bulk. Entries
        # reach the solver only through fixtures, so only a guest entry that is
        # **seated** in the played draw is a solver input — its withdrawal is
        # what the broken-pin repair (``app.match_calls``) reacts to. A guest
        # who entered after the cut sits in no fixture and their leaving
        # changes no solver input until a re-cut, which triggers on its own.
        # The seated-EXISTS form is chosen over a per-tournament
        # ``tournament_has_drawn_event`` gate because a played event has
        # fixtures BY CONSTRUCTION — that gate would be vacuously true here
        # and would enqueue for never-seated withdrawals; one EXISTS over the
        # data already in hand answers the real question.
        solve_tournament_ids.update(
            (
                await db.execute(
                    select(TournamentEvent.tournament_id)
                    .distinct()
                    .join(
                        TournamentEntry,
                        TournamentEntry.event_id == TournamentEvent.id,
                    )
                    .where(
                        TournamentEntry.id.in_(source_entry_ids),
                        TournamentEntry.status == TournamentEntryStatus.entered,
                        TournamentEntry.event_id.in_(played_event_ids),
                        exists(
                            select(TournamentFixture.id).where(
                                or_(
                                    TournamentFixture.entry_a_id == TournamentEntry.id,
                                    TournamentFixture.entry_b_id == TournamentEntry.id,
                                )
                            )
                        ),
                    )
                )
            )
            .scalars()
            .all()
        )
        # Preserve played fixtures and original memberships.
        await db.execute(
            update(TournamentEntry)
            .where(
                TournamentEntry.id.in_(source_entry_ids),
                TournamentEntry.status == TournamentEntryStatus.entered,
                TournamentEntry.event_id.in_(played_event_ids),
            )
            .values(status=TournamentEntryStatus.withdrawn)
        )

    # Read which unplayed events had a draw before un-cutting it. Only a
    # removed draw owes a solve; an undrawn event has no schedule to change.
    # ``event_id`` no longer lives on the fixture (ADR 20260815 decision 5); the event
    # is reachable through the stage.
    drawn_unplayed_event_ids = set(
        (
            await db.execute(
                select(TournamentEventStage.event_id)
                .distinct()
                .join(
                    TournamentFixture,
                    TournamentFixture.stage_id == TournamentEventStage.id,
                )
                .where(TournamentEventStage.event_id.in_(unplayed_event_ids))
            )
        )
        .scalars()
        .all()
    )

    # (2) Withdraw the losing entry, retaining its original membership history.
    await db.execute(
        text(
            """
            UPDATE tournament_entries AS te SET status = 'withdrawn'
            WHERE te.id = ANY(:source_entry_ids)
              AND te.status = :active
              AND te.event_id IN (
                SELECT id FROM tournament_events
                WHERE NOT allow_multiple_entries_per_player
              )
              AND EXISTS (
                SELECT 1 FROM tournament_entries other
                WHERE other.id = ANY(:target_entry_ids)
                  AND other.event_id = te.event_id
                  AND other.status = :active
              )
            """
        ),
        params,
    )

    for _, duplicate_id, retained_id in collisions:
        await close_registration(
            db, duplicate_id, actor_account_id, WithdrawalReason.identity_reconciliation
        )
        await db.execute(
            update(TournamentEntry)
            .where(TournamentEntry.id == duplicate_id)
            .values(
                status=TournamentEntryStatus.withdrawn,
                superseded_by_entry_id=retained_id,
            )
        )

    # Retire only unplayed draws whose active field changed. The shared operation
    # preserves the previous revision, fixtures and ended participation periods.
    await uncut_draw(db, unplayed_event_ids)

    # The uncut arm's solve gate, AFTER the un-cut — uncut_event_draw's
    # doctrine: the former draw was retired, which frees this event's
    # tables and windows for whatever is still drawn, so a solve is owed only
    # where a drawn event SURVIVES (same helper, same reasoning: un-cutting the
    # tournament's only draw leaves nothing to place, and a solve row over an
    # empty board is a no-op ledger entry). Checked per tournament, and only
    # for tournaments the withdrawal arm has not already claimed.
    for event_id in drawn_unplayed_event_ids:
        tournament_id = event_tournament_ids[event_id]
        if tournament_id in solve_tournament_ids:
            continue
        if await tournament_has_drawn_event(db, tournament_id):
            solve_tournament_ids.add(tournament_id)

    # The re-solve every scheduling-input mutation above funnels into — same
    # transaction, under the tournament row locks taken at the top (the order
    # ``request_solve`` requires). One enqueue per affected tournament, in id
    # order for determinism. A ``None`` return (Redis down: ``request_solve``
    # logged and took its row back out) is DELIBERATELY tolerated — the same
    # doctrine as go-live: it costs the solve, never the merge. A sign-in must
    # not fail because the scheduler could not hear about it; the pin tick and
    # the Run-scheduler button recover the missing solve.
    for tournament_id in sorted(solve_tournament_ids):
        await request_solve(db, tournament_id, ScheduleSolveTrigger.settings_changed)


async def _self_play_collision(
    db: AsyncSession,
    *,
    from_user_id: uuid.UUID,
    to_user_id: uuid.UUID,
) -> _SelfPlayCollision:
    """Find the *rated* matches on which ``from_user_id`` and ``to_user_id`` sat
    on OPPOSITE sides (see ADR-0013).

    ``match_side_id <> match_side_id`` is what makes this "opposite sides", and
    it is the discriminator that excludes a solo match: a solo match's second
    side is player-less, so the verified user is never a participant and never
    joins. ``affects_rating`` is the discriminator against a completed-but-
    unrated collision — an unrated match never counted, so it keeps the ordinary
    prune (nothing to void). Doubles teammates (same side) are excluded too:
    dropping one leaves the side non-empty, so there is no half-delete to fix.

    Must run before any re-point/delete, while the ephemeral user's side rows
    are still intact.
    """
    rows = (
        await db.execute(
            text(
                """
                SELECT msp_from.match_side_id AS from_side_id,
                       msp_from.match_id AS match_id
                FROM match_side_players AS msp_from
                JOIN matches AS m ON m.id = msp_from.match_id
                JOIN match_settings AS ms
                  ON ms.id = m.match_settings_id
                 AND ms.affects_rating = true
                JOIN match_side_players AS msp_to
                  ON msp_to.match_id = msp_from.match_id
                 AND msp_to.user_id = :to_id
                 AND msp_to.match_side_id <> msp_from.match_side_id
                WHERE msp_from.user_id = :from_id
                """
            ),
            {"from_id": from_user_id, "to_id": to_user_id},
        )
    ).all()
    return _SelfPlayCollision(
        match_ids=frozenset(row.match_id for row in rows),
        from_side_ids=frozenset(row.from_side_id for row in rows),
    )


async def _repoint_match_side_players(
    db: AsyncSession,
    *,
    from_user_id: uuid.UUID,
    to_user_id: uuid.UUID,
) -> int:
    """Re-point match_side_players from ephemeral → verified. Returns the row
    count, which equals the number of matches moved because UNIQUE(match_id,
    user_id) caps it at one row per match. NOT EXISTS skips the impossible-
    but-defendable case where both users are already on the same match."""
    result = await db.execute(
        text(
            """
            UPDATE match_side_players AS msp
            SET user_id = :to_id
            WHERE msp.user_id = :from_id
              AND NOT EXISTS (
                SELECT 1 FROM match_side_players other
                WHERE other.user_id = :to_id
                  AND other.match_id = msp.match_id
              )
            """
        ),
        {"from_id": from_user_id, "to_id": to_user_id},
    )
    return cast(CursorResult[Any], result).rowcount or 0

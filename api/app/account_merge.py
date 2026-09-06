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
    LeagueMembership,
    Match,
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
    TournamentEntryStatus,
    TournamentEvent,
    TournamentEventStage,
    TournamentFixture,
    User,
    UserLeagueRating,
    UserRole,
    UserToken,
)
from app.schedule_solves import request_solve, tournament_has_drawn_event
from app.tournament_draws import draw_has_play, uncut_draw

# Must match ``app.sessions.SESSION_TOKEN_CONTEXT``. Hardcoded to avoid a
# circular import (sessions imports this module). Session tokens are KEPT on the
# tombstoned guest so its cookie still resolves; every other token is dropped.
_SESSION_TOKEN_CONTEXT = "session"

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
        )
    ).all()
    by_id = {account.id: account for account in accounts}
    source, target = by_id.get(from_user_id), by_id.get(to_user_id)
    if source is None or target is None:
        raise ValueError("Both accounts must exist")
    if source.merged_into_user_id is not None or target.merged_into_user_id is not None:
        raise ValueError("Cannot merge a tombstoned account")
    source_player, target_player = source.primary_player, target.primary_player
    if len(source.player_grants) > 1:
        raise ValueError("Merging accounts that manage multiple players is not enabled")
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
        summary = await _merge_players(
            db, from_user_id=source_player.id, to_user_id=target_player.id
        )
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
    source.display_name = source.username
    source.player_grants.clear()
    await db.flush()
    await db.execute(
        update(Tournament)
        .where(Tournament.owner_account_id == from_user_id)
        .values(owner_account_id=to_user_id)
    )
    await _transfer_account(db, from_user_id=from_user_id, to_user_id=to_user_id)
    return summary


async def _merge_players(
    db: AsyncSession,
    *,
    from_user_id: uuid.UUID,
    to_user_id: uuid.UUID,
) -> MergeSummary:
    """Combine sporting records under the existing collision and rating rules."""
    await db.execute(
        update(MatchResult)
        .where(MatchResult.submitted_for_player_id == from_user_id)
        .values(submitted_for_player_id=to_user_id)
    )
    collision = await _self_play_collision(
        db, from_user_id=from_user_id, to_user_id=to_user_id
    )

    matches_moved = await _repoint_match_side_players(
        db, from_user_id=from_user_id, to_user_id=to_user_id
    )

    await _resolve_entry_collisions(
        db, from_user_id=from_user_id, to_user_id=to_user_id
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
    if collision.match_ids:
        collided_matches = (
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
    await db.execute(
        update(Player)
        .where(Player.id == from_user_id)
        .values(merged_into_player_id=to_user_id, merged_at=datetime.now(UTC))
    )
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
        delete(UserToken).where(
            UserToken.user_id == from_user_id,
            UserToken.context != _SESSION_TOKEN_CONTEXT,
        )
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
) -> None:
    """Reconcile colliding singles entries without erasing membership history.

    The survivor inherits the earlier registration time and an absent seed from
    the source. The source entry is withdrawn, whether or not its draw has play;
    the recorded member Player stays intact and its singles projection follows
    the explicit same-person merge chain.

    An unplayed draw is un-cut, not patched: it was seeded for a field that
    double-counted one human, so replacing just the source fixture seats would
    leave an invalid draw. A played draw remains unchanged. Self-play matches
    exposed by reconciliation follow the existing transfer-and-void rules.

    Only affected events are reconciled. Scheduling changes request at most one
    solve per tournament under the existing tournament-row locks. This runs in
    the caller's transaction, making withdrawal and draw reconciliation atomic.
    """
    params = {
        "from_id": from_user_id,
        "to_id": to_user_id,
        "active": _ACTIVE_ENTRY_STATUS,
    }

    # Read before withdrawal removes the active collision from these queries.
    collided_event_ids = set(
        (
            await db.execute(
                text(
                    """
                    SELECT guest.event_id
                    FROM tournament_entries AS guest
                    JOIN tournament_entries AS survivor
                      ON survivor.event_id = guest.event_id
                     AND entry_single_player(survivor.id) = :to_id
                     AND survivor.status = :active
                    WHERE entry_single_player(guest.id) = :from_id
                      AND guest.status = :active
                      AND guest.event_id IN (
                        SELECT id FROM tournament_events
                        WHERE NOT allow_multiple_entries_per_player
                      )
                    """
                ),
                params,
            )
        )
        .scalars()
        .all()
    )
    if not collided_event_ids:
        return

    # Every mutation below is a **scheduling input** changing (ADR "the schedule
    # is solved; the call is pinned"): a withdrawal or an un-cut.
    # ``request_solve``'s contract wants the
    # tournament row lock held first, and the lock ORDER every writer follows is
    # tournament → schedule_solves → tournament_fixtures — so the collided
    # tournaments are locked HERE, before any entry mutation or draw un-cut
    # takes downstream row locks. ``merge_user`` holds no tournament lock of its
    # own here — the same situation ``on_match_completed`` is in, and the
    # same remedy: take the lock yourself. Ordered by id so two concurrent
    # merges touching the same pair of tournaments lock them in one order
    # instead of deadlocking. (The ownership re-point earlier in ``merge_user``
    # may already hold some of these rows — re-locking a row this transaction
    # holds is a no-op, so no inversion is introduced within the merge itself.)
    # The lock also makes the ``draw_has_play`` partition below read what the
    # last committed writer wrote, exactly as the cut/un-cut routes read it.
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

    # Partition the collided events by evidence of play (a fixture with a ``match_id``
    # or a ``winner_entry_id`` — the ``draw_has_play`` the cut/un-cut verbs gate on).
    # An **unplayed** event's draw is regenerated (steps 1–3 below); a **played** one's
    # cannot be — its matches exist and may carry scores — so its guest entry is
    # withdrawn instead, and its self-play matches ride ``merge_user``'s ADR-0013 path.
    played_event_ids = {
        event_id for event_id in collided_event_ids if await draw_has_play(db, event_id)
    }
    unplayed_event_ids = collided_event_ids - played_event_ids

    # Which tournaments this collision's mutations owe a re-solve. Filled by
    # both arms below, deduped so a merge that touches two events of one
    # tournament enqueues at most one solve for it (``request_solve`` would
    # coalesce the duplicate anyway; no reason to make it).
    solve_tournament_ids: set[uuid.UUID] = set()

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
                        TournamentEntry.user_id == from_user_id,
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
        # Preserve played fixtures and original memberships. Withdrawal also
        # removes these collisions from the unplayed-event self-joins below.
        await db.execute(
            update(TournamentEntry)
            .where(
                TournamentEntry.user_id == from_user_id,
                TournamentEntry.status == TournamentEntryStatus.entered,
                TournamentEntry.event_id.in_(played_event_ids),
            )
            .values(status=TournamentEntryStatus.withdrawn)
        )

    # (1) Registration order and seed follow the earlier registration onto the
    # survivor.
    await db.execute(
        text(
            """
            UPDATE tournament_entries AS survivor
            SET created_at = LEAST(survivor.created_at, guest.created_at),
                seed = COALESCE(survivor.seed, guest.seed)
            FROM tournament_entries AS guest
            WHERE entry_single_player(survivor.id) = :to_id
              AND survivor.status = :active
              AND entry_single_player(guest.id) = :from_id
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
            WHERE entry_single_player(te.id) = :from_id
              AND te.status = :active
              AND te.event_id IN (
                SELECT id FROM tournament_events
                WHERE NOT allow_multiple_entries_per_player
              )
              AND EXISTS (
                SELECT 1 FROM tournament_entries other
                WHERE entry_single_player(other.id) = :to_id
                  AND other.event_id = te.event_id
                  AND other.status = :active
              )
            """
        ),
        params,
    )

    # (3) Un-cut the draws the double-counted field invalidated — the **unplayed** ones
    # only. A played event's draw cannot be un-cut (the play guard, and it would delete
    # the fixtures its matches hang off); its guest entry was withdrawn above instead.
    # ``uncut_draw`` is the one place a draw is deleted (ADR-0786) — a hand-rolled
    # DELETE here would be a second spelling of "this event has no draw" to keep in step
    # with the first — and it no-ops on an empty set, so an all-played collision deletes
    # nothing. It takes the ids straight: the events themselves are never needed, so
    # loading them would be a SELECT run purely to read back the ids we already hold.
    await uncut_draw(db, unplayed_event_ids)

    # The uncut arm's solve gate, AFTER the un-cut — uncut_event_draw's
    # doctrine: fixtures were deleted wholesale, which frees this event's
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

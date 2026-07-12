"""Re-point ownership from an ephemeral user to a verified user, then
*tombstone* (soft-delete) the ephemeral user. Called from sign-in
(``/v1/login/consume``) and email confirmation (``/v1/me/email/confirm``) when
the browser arrived with a different ephemeral session than the target account.

The ephemeral row is kept (``merged_into_user_id`` set) rather than dropped so
its session token still resolves and the auth layer can tell the holder their
session was merged instead of silently minting a fresh guest. Because we no
longer rely on ``ON DELETE CASCADE``, the ephemeral user's owned rows are handled
explicitly here: grants worth keeping (roles) are re-pointed onto the survivor,
and the rest (leftover league rows, rating history, non-session tokens) are
cleaned up.

Leaves the verified user's ``user_league_ratings`` and ``rating_history``
stale relative to the freshly-moved matches — the caller enqueues the
``app.ratings.jobs.recompute_after_merge`` background job to reconcile.
"""

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, cast

from sqlalchemy import CursorResult, delete, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.match_voiding import void_match
from app.models import (
    DeviceToken,
    LeagueMembership,
    Match,
    MatchResult,
    MatchSide,
    MatchSidePlayer,
    Notification,
    NotificationChannelSetting,
    NotificationPreference,
    RatingHistory,
    Tournament,
    TournamentEntryStatus,
    User,
    UserLeagueRating,
    UserRole,
    UserToken,
)

# Must match ``app.sessions.SESSION_TOKEN_CONTEXT``. Hardcoded to avoid a
# circular import (sessions imports this module). Session tokens are KEPT on the
# tombstoned guest so its cookie still resolves; every other token is dropped.
_SESSION_TOKEN_CONTEXT = "session"

# The stored value of an *active* tournament entry, sourced from the enum rather
# than written into the SQL below as a literal. The model, the routes and the
# partial unique index all derive "active" from ``TournamentEntryStatus``; a
# hardcoded ``'entered'`` here would silently stop matching if that value were
# ever renamed, and the failure mode is nasty rather than obvious — the dedup's
# EXISTS would find nothing, delete nothing, and the unconditional re-point that
# follows would then collide with the partial unique index, raising
# IntegrityError and failing the whole sign-in merge. Bind it, don't spell it.
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
    """Re-point ``from_user_id``'s data onto ``to_user_id`` and tombstone the
    ephemeral row (``merged_into_user_id`` set; row kept). Runs inside the
    caller's transaction — does not commit.

    Caller invariants:
      * ``from_user_id`` is ephemeral (``confirmed_at IS NULL``).
      * ``to_user_id`` already exists.
      * ``from_user_id != to_user_id``.
    """
    if from_user_id == to_user_id:
        # A self-merge would no-op every UPDATE and then the final tombstone
        # DELETE would destroy the surviving account. Refuse loudly rather
        # than silently lose the user.
        raise ValueError("merge_user: from_user_id must not equal to_user_id")

    # A *self-play collision* is a rated match on which the guest and the
    # verified user sat on OPPOSITE sides — the merge is the moment we learn it
    # was always one person playing themselves (ADR-0013). Detect it up front,
    # before any re-point/delete has disturbed the side rows. The remedy (void
    # the match, keep the emptied side player-less) diverges from the ordinary
    # prune below; see there.
    collision = await _self_play_collision(
        db, from_user_id=from_user_id, to_user_id=to_user_id
    )

    matches_moved = await _repoint_match_side_players(
        db, from_user_id=from_user_id, to_user_id=to_user_id
    )

    await db.execute(
        update(Match)
        .where(Match.created_by_user_id == from_user_id)
        .values(created_by_user_id=to_user_id)
    )

    # Re-point posted-result authorship: ``match_results.submitted_by_user_id``
    # is RESTRICT, and the row is match history we keep — so move it to the
    # survivor rather than dropping it. No uniqueness to dodge.
    await db.execute(
        update(MatchResult)
        .where(MatchResult.submitted_by_user_id == from_user_id)
        .values(submitted_by_user_id=to_user_id)
    )

    # Re-point result acceptance: ``match_results.accepted_by_user_id`` is
    # nullable RESTRICT with no uniqueness — move it to the survivor like the
    # submitter above so the FK doesn't block the final tombstone delete.
    await db.execute(
        update(MatchResult)
        .where(MatchResult.accepted_by_user_id == from_user_id)
        .values(accepted_by_user_id=to_user_id)
    )

    # Preserve tournament ownership across a guest→verified merge — re-point
    # rather than letting the RESTRICT FK block the final tombstone delete.
    await db.execute(
        update(Tournament)
        .where(Tournament.created_by_user_id == from_user_id)
        .values(created_by_user_id=to_user_id)
    )

    # Carry the guest's tournament entries onto the survivor. An entry is a
    # registration in a real event (a draw gets seeded from it), and the FK is
    # RESTRICT — but we TOMBSTONE the guest rather than deleting it, so ON DELETE
    # never fires and an unhandled entry would simply stay registered to a ghost.
    #
    # Dedup, then re-point. The uniqueness guard on ``tournament_entries`` is
    # PARTIAL — ``UNIQUE (event_id, user_id) WHERE status = 'entered'``
    # (ADR-0016) — so the ONLY rows that can collide are a guest ACTIVE entry in
    # an event the survivor is ALSO actively entered in. Drop the guest's losing
    # row first: the survivor's entry stands, so the event's active-entry count is
    # unchanged by the merge (it was one person all along).
    #
    # The predicate tests ``status``, not the (event, user) pair alone, because
    # two *withdrawn* rows for the same pair are legal — soft-deleted history the
    # partial index deliberately permits. Deleting those would destroy withdrawal
    # history the index exists to keep. "Active" is bound as ``:active`` from
    # ``_ACTIVE_ENTRY_STATUS`` (see above) so this SQL cannot drift from the enum.
    await db.execute(
        text(
            """
            DELETE FROM tournament_entries AS te
            WHERE te.user_id = :from_id
              AND te.status = :active
              AND EXISTS (
                SELECT 1 FROM tournament_entries other
                WHERE other.user_id = :to_id
                  AND other.event_id = te.event_id
                  AND other.status = :active
              )
            """
        ),
        {
            "from_id": from_user_id,
            "to_id": to_user_id,
            "active": _ACTIVE_ENTRY_STATUS,
        },
    )
    # Nothing left can collide, so the re-point is unconditional and total: every
    # remaining guest entry — active or withdrawn — moves onto the survivor, and
    # no row is left pointing at the tombstone for the cleanup below to sweep.
    await db.execute(
        text(
            """
            UPDATE tournament_entries
            SET user_id = :to_id
            WHERE user_id = :from_id
            """
        ),
        {"from_id": from_user_id, "to_id": to_user_id},
    )

    # Now the *other* users FK on the same table: ``added_by_user_id`` — who put
    # this player in the event (ADR-0784). The guest may have been a DIRECTOR who
    # entered other people; the entries they created are still perfectly valid
    # registrations of real players, so there is nothing here to delete. What must
    # not survive is the pointer: the guest is about to become a tombstone, and an
    # entry left saying "added by <ghost>" would render as an adder who no longer
    # exists. The adder and the survivor are the same human — so the adder FOLLOWS
    # the merge, exactly as tournament *ownership* does above.
    #
    # Must run AFTER the ``user_id`` re-point, because it reads the post-merge
    # ``user_id`` — which is what the CASE is for. If the guest director is merged
    # into the very player they entered (I create a tournament as a guest, add
    # "Rita" from search, then sign in and turn out to BE Rita), then after the
    # merge one person both added and is the entry: that is self-registration, and
    # self-registration is spelled NULL. Writing ``added_by = user_id`` instead
    # would leave two different encodings of "entered themselves" in the column and
    # let "added by the director" appear on a director-less entry. Collapse it.
    # (``test_merge_collapses_a_guest_who_both_added_and_is_the_entry`` is what pins
    # that ordering: reorder these two statements and both direction tests go red.)
    #
    # The WHERE catches **both** ids, and the second one is not decoration — it is
    # the mirror of the case above, and it is the merge's own doing. Take a director
    # D with a real account who enters a GUEST player P (``user_id = P``,
    # ``added_by = D``); P then signs in and turns out to BE D. The re-point above
    # rewrites ``user_id`` to D — and a WHERE that only looked for ``:from_id``
    # would not match this row at all, leaving ``added_by == user_id == D``: the very
    # contradictory encoding this CASE exists to prevent, *manufactured by the merge*
    # rather than merely passed through it. Matching ``:to_id`` as well lets the same
    # CASE collapse it to NULL. The extra rows that predicate sweeps in — an entry
    # already added by the survivor, whose entrant is somebody else — are re-pointed
    # from ``to_id`` to ``to_id``, which is a no-op by construction.
    #
    # So the invariant is: after this statement, no row whose ``user_id`` or
    # ``added_by_user_id`` was touched by this merge can say ``added_by == user_id``.
    #
    # Note this deliberately does NOT re-point rows whose *entry* was dropped by
    # the dedup DELETE above — they no longer exist, so there is nothing to point.
    await db.execute(
        text(
            """
            UPDATE tournament_entries
            SET added_by_user_id =
                CASE WHEN user_id = :to_id THEN NULL ELSE :to_id END
            WHERE added_by_user_id IN (:from_id, :to_id)
            """
        ),
        {"from_id": from_user_id, "to_id": to_user_id},
    )

    # Preserve the audit trail by re-pointing rather than letting the FK's
    # ON DELETE SET NULL null it out when the ephemeral user is deleted.
    await db.execute(
        update(RatingHistory)
        .where(RatingHistory.created_by_user_id == from_user_id)
        .values(created_by_user_id=to_user_id)
    )

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
    await db.execute(delete(RatingHistory).where(RatingHistory.user_id == from_user_id))
    await db.execute(
        delete(UserLeagueRating).where(UserLeagueRating.user_id == from_user_id)
    )
    await db.execute(
        delete(LeagueMembership).where(LeagueMembership.user_id == from_user_id)
    )
    await db.execute(
        delete(UserToken).where(
            UserToken.user_id == from_user_id,
            UserToken.context != _SESSION_TOKEN_CONTEXT,
        )
    )

    # Tombstone: keep the row (and its session tokens) so the guest's cookie
    # still resolves and the auth layer can report the merge.
    await db.execute(
        update(User)
        .where(User.id == from_user_id)
        .values(merged_into_user_id=to_user_id, merged_at=datetime.now(UTC))
    )
    await db.flush()

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

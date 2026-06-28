"""Re-point ownership from an ephemeral user to a verified user, then
*tombstone* (soft-delete) the ephemeral user. Called from sign-in
(``/v1/login/consume``) and email confirmation (``/v1/me/email/confirm``) when
the browser arrived with a different ephemeral session than the target account.

The ephemeral row is kept (``merged_into_user_id`` set) rather than dropped so
its session token still resolves and the auth layer can tell the holder their
session was merged instead of silently minting a fresh guest. Because we no
longer rely on ``ON DELETE CASCADE``, the ephemeral user's owned rows
(roles, leftover league rows, rating history, non-session tokens) are cleaned up
explicitly here.

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

from app.models import (
    DeviceToken,
    LeagueMembership,
    Match,
    MatchResult,
    MatchResultResponse,
    MatchSide,
    MatchSidePlayer,
    Notification,
    NotificationChannelSetting,
    NotificationPreference,
    RatingHistory,
    Tournament,
    User,
    UserLeagueRating,
    UserRole,
    UserToken,
)

# Must match ``app.sessions.SESSION_TOKEN_CONTEXT``. Hardcoded to avoid a
# circular import (sessions imports this module). Session tokens are KEPT on the
# tombstoned guest so its cookie still resolves; every other token is dropped.
_SESSION_TOKEN_CONTEXT = "session"


@dataclass(frozen=True)
class MergeSummary:
    matches_moved: int


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

    matches_moved = await _repoint_match_side_players(
        db, from_user_id=from_user_id, to_user_id=to_user_id
    )
    await _repoint_match_result_responses(
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

    # Preserve tournament ownership across a guest→verified merge — re-point
    # rather than letting the RESTRICT FK block the final tombstone delete.
    await db.execute(
        update(Tournament)
        .where(Tournament.created_by_user_id == from_user_id)
        .values(created_by_user_id=to_user_id)
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
    await db.execute(
        delete(MatchSidePlayer).where(MatchSidePlayer.user_id == from_user_id)
    )
    # The collision case is self-play across two guest sessions (both sides of
    # the same match were the same real person). The NOT EXISTS guard skipped
    # re-pointing the ephemeral side because the verified user was already
    # there; the DELETE above then removed that MatchSidePlayer, leaving a
    # playerless MatchSide. Prune those now-empty sides so they don't surface
    # as "No opponent" / "vs Guest" in match history. Scope the prune to the
    # sides the ephemeral user actually sat on — a global ``no players`` filter
    # would also wipe the intentional player-less "sentinel" side that every
    # opponent-less (solo) match carries by design.
    if ephemeral_side_ids:
        await db.execute(
            delete(MatchSide).where(
                MatchSide.id.in_(ephemeral_side_ids),
                ~MatchSide.players.any(),
            )
        )
    # Same RESTRICT story for match_result_responses — defensive drop after
    # repoint. (match_results.submitted_by has no uniqueness, so its repoint
    # above always covers every row — no defensive drop needed there.)
    await db.execute(
        delete(MatchResultResponse).where(MatchResultResponse.user_id == from_user_id)
    )

    # We tombstone rather than DELETE the user, so the rows that used to ride
    # ``ON DELETE CASCADE`` must be dropped explicitly. Order doesn't matter —
    # none of these reference each other. Keep the guest's *session* tokens so
    # its cookie still resolves to this (now-tombstoned) row.
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

    return MergeSummary(matches_moved=matches_moved)


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


async def _repoint_match_result_responses(
    db: AsyncSession,
    *,
    from_user_id: uuid.UUID,
    to_user_id: uuid.UUID,
) -> None:
    """Re-point match_result_responses from ephemeral → verified.
    UNIQUE(result_id, user_id) collides only if both users somehow already
    responded to the same result — left out by NOT EXISTS; the ephemeral row
    will then be dropped by the defensive ``DELETE`` in ``merge_user``."""
    await db.execute(
        text(
            """
            UPDATE match_result_responses AS mrr
            SET user_id = :to_id
            WHERE mrr.user_id = :from_id
              AND NOT EXISTS (
                SELECT 1 FROM match_result_responses other
                WHERE other.user_id = :to_id
                  AND other.result_id = mrr.result_id
              )
            """
        ),
        {"from_id": from_user_id, "to_id": to_user_id},
    )

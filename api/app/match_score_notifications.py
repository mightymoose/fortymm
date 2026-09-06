"""Player notices for a tournament director's per-game score changes."""

import uuid
from typing import Literal

from sqlalchemy.ext.asyncio import AsyncSession

from app.match_queries import is_tournament_director
from app.models import Match, User
from app.notifications.taxonomy import NotificationCategory
from app.player_accounts import managing_account_ids
from app.schemas.notification import NotificationJob


async def director_score_notices(
    db: AsyncSession,
    match: Match,
    actor_id: uuid.UUID,
    *,
    game_number: int,
    action: Literal["recorded", "corrected", "cleared"],
    points: tuple[int, int] | None = None,
) -> list[NotificationJob]:
    """Build before the write commits; enqueue only after it succeeds."""
    if not await is_tournament_director(db, match.id, actor_id):
        return []
    actor = await db.get(User, actor_id)
    if actor is None:
        return []
    body = f"{actor.username}, the tournament director, {action} game {game_number}"
    names = {
        side.side_number: " / ".join(player.user.username for player in side.players)
        for side in match.sides
    }
    if points is not None:
        body += (
            f": {names.get(1, 'Side 1')} {points[0]}–{points[1]} "
            f"{names.get(2, 'Side 2')}"
        )
    else:
        body += f" of {names.get(1, 'Side 1')} vs {names.get(2, 'Side 2')}"
    body += ". View your match for the current score."
    return [
        NotificationJob(
            user_id=account_id,
            category=NotificationCategory.RESULT_CONFIRM,
            title=f"Your game score was {action}",
            body=body,
            link=f"/matches/{match.id}",
            action_label="View match",
        )
        for side in match.sides
        for player in side.players
        for account_id in await managing_account_ids(db, [player.user_id])
        if account_id != actor_id
    ]

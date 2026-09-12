"""Original rating attribution survives independently identified Accounts/Players."""

from datetime import UTC, datetime

from sqlalchemy import delete, select

from app.account_merge import merge_user
from app.leagues import get_default_league
from app.models import Account, AccountPlayer, Player, RatingHistory, UserLeagueRating
from app.player_accounts import require_player
from app.ratings.inputs import rating_inputs, record_rating_input
from app.ratings.recompute import recompute_league_ratings


async def test_merge_keeps_distinct_original_player_and_acting_account(db_session):
    original_player = Player(username="original-rating-player")
    surviving_player = Player(username="surviving-rating-player")
    original_account = Account(
        player_grants=[AccountPlayer(player=original_player, is_primary=True)]
    )
    surviving_account = Account(
        email="rating-survivor@example.com",
        player_grants=[AccountPlayer(player=surviving_player, is_primary=True)],
    )
    db_session.add_all([original_account, surviving_account])
    await db_session.commit()
    original_player_id, surviving_player_id = original_player.id, surviving_player.id
    original_account_id = original_account.id
    surviving_account_id = surviving_account.id
    assert (
        len(
            {
                original_player_id,
                surviving_player_id,
                original_account_id,
                surviving_account_id,
            }
        )
        == 4
    )
    assert (
        await require_player(db_session, original_account_id, original_player_id)
    ).id == original_player_id

    league = await get_default_league(db_session)
    league_id = league.id
    original = await record_rating_input(
        db_session,
        league_id,
        original_player_id,
        actor_account_id=original_account_id,
        rating=1675,
        source="import",
        effective_at=datetime(2026, 1, 1, tzinfo=UTC),
    )
    input_id = original.id
    await db_session.commit()

    await merge_user(
        db_session,
        from_user_id=original_account_id,
        to_user_id=surviving_account_id,
    )
    await db_session.commit()
    # Both calculated stores can disappear without losing the original fact.
    await db_session.execute(delete(RatingHistory))
    await db_session.execute(delete(UserLeagueRating))
    await recompute_league_ratings(db_session, league_id, {surviving_player_id})
    await db_session.commit()
    db_session.expunge_all()

    (retained,) = await rating_inputs(db_session, league_id, surviving_player_id)
    assert retained.id == input_id
    assert retained.player_id == original_player_id
    assert retained.actor_account_id == original_account_id
    projection = await db_session.scalar(
        select(RatingHistory).where(RatingHistory.rating_input_id == input_id)
    )
    assert projection.user_id == surviving_player_id
    assert projection.created_by_user_id == original_account_id
    current = await db_session.scalar(
        select(UserLeagueRating).where(
            UserLeagueRating.league_id == league_id,
            UserLeagueRating.user_id == surviving_player_id,
        )
    )
    assert current.rating_value == 1675

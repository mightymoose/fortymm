"""Rebuilding one connected history must not hydrate unrelated league matches."""

from datetime import UTC, datetime

from sqlalchemy import event

from app.leagues import get_default_league
from app.models import Match
from app.ratings.recompute import recompute_league_ratings
from tests._helpers import make_user
from tests.test_rating_recompute import _build_completed_match


async def test_replay_loads_only_matches_reachable_from_seed_players(db_session):
    league = await get_default_league(db_session)
    a, b, c, x, y = [
        await make_user(db_session, f"bounded-replay-{name}")
        for name in ["a", "b", "c", "x", "y"]
    ]
    earlier = await _build_completed_match(
        db_session, league, b, c, datetime(2026, 1, 1, tzinfo=UTC)
    )
    later = await _build_completed_match(
        db_session, league, a, b, datetime(2026, 1, 2, tzinfo=UTC)
    )
    unrelated = await _build_completed_match(
        db_session, league, x, y, datetime(2026, 1, 3, tzinfo=UTC)
    )
    league_id, player_id = league.id, a.id
    expected_ids, unrelated_id = {earlier.id, later.id}, unrelated.id
    db_session.expunge_all()
    loaded = set()

    def capture_match(_session, instance):
        if isinstance(instance, Match):
            loaded.add(instance.id)

    event.listen(db_session.sync_session, "loaded_as_persistent", capture_match)
    try:
        await recompute_league_ratings(db_session, league_id, {player_id})
        await db_session.commit()
    finally:
        event.remove(db_session.sync_session, "loaded_as_persistent", capture_match)
    assert expected_ids <= loaded
    assert unrelated_id not in loaded

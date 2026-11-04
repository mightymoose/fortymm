"""Matches between two players, made directly in the database, for the
tests of the rule that two players who played each other never merge."""

import uuid

from sqlalchemy import insert, select
from sqlalchemy.orm import Session

from fortymm_api.accounts import PlayerId
from fortymm_api.matches import MatchId
from fortymm_api.models import (
    League,
    Match,
    MatchSettings,
    MatchSide,
    MatchSidePlayer,
    StoredMatchResult,
)


def played(
    session: Session,
    players: tuple[PlayerId, PlayerId],
    *,
    rated: bool = True,
    with_result: bool = True,
) -> MatchId:
    """A best of 3 between `players` in the default league, with a result
    unless told otherwise. The rule reads only that a result exists, so its
    payload is random bytes."""
    match = MatchId(uuid.uuid4())
    settings = session.scalars(
        insert(MatchSettings)
        .values(team_size=1, best_of=3, rated=rated)
        .returning(MatchSettings.id)
    ).one()
    league = session.scalars(select(League.id).where(League.is_default)).one()
    session.execute(
        insert(Match).values(id=match, settings_id=settings, league_id=league)
    )
    for side, player in enumerate(players):
        side_id = session.scalars(
            insert(MatchSide).values(match_id=match, side=side).returning(MatchSide.id)
        ).one()
        session.execute(
            insert(MatchSidePlayer).values(
                match_side_id=side_id, match_id=match, player_id=player
            )
        )
    if with_result:
        session.execute(
            insert(StoredMatchResult).values(match_id=match, payload=uuid.uuid4().bytes)
        )
    return match

"""A void reconciles after it advances the remaining draw."""

import uuid

from sqlalchemy import select

from app.models import TournamentFixture, TournamentStatus
from app.official_results import void_official_match
from app.result_proposal import propose_result
from tests._helpers import make_user
from tests.test_official_results import board
from tests.test_rr_then_ko import (
    RESERVATIONS,
    _call,
    _create_event,
    _cut,
    _enter,
    _fixtures,
    _is_knockout,
    _set_status,
    _tournament,
)
from tests.test_rr_then_ko import (
    authed_client as authed_client,
)


async def test_void_that_seats_qualifiers_commits_final_reconciliation(
    authed_client, db_session
):
    client, owner = authed_client
    tournament_id = await _tournament(client)
    event_id = (
        await _create_event(
            client,
            tournament_id,
            max_players=4,
            reservations=[RESERVATIONS[0]],
            match_settings={"rated": False, "length_games": 1},
        )
    ).json()["id"]
    for seed in range(1, 5):
        player = await make_user(db_session, f"void-advance-{seed}")
        await _enter(db_session, event_id, player, seed=seed, minutes=seed)
    assert (await _cut(client, tournament_id, event_id)).status_code == 201
    await _set_status(db_session, tournament_id, TournamentStatus.published)
    assert (
        await client.post(
            f"/v1/tournaments/{tournament_id}/transitions", json={"to": "live"}
        )
    ).status_code == 201
    fixtures = await _fixtures(db_session, event_id)
    group = [fixture for fixture in fixtures if not _is_knockout(fixture)]
    await _call(db_session, tournament_id, group)
    for fixture in group[:-1]:
        await propose_result(
            db_session,
            fixture.match_id,
            owner.id,
            games=board(),
            supersedes_result_id=None,
        )
        await db_session.commit()
    await void_official_match(
        db_session, group[-1].match_id, owner.id, reason="Pairing cannot be played"
    )
    await db_session.commit()
    db_session.expire_all()
    fixtures = list(
        await db_session.scalars(
            select(TournamentFixture).where(
                TournamentFixture.scope_event_id == uuid.UUID(event_id)
            )
        )
    )
    bracket = [fixture for fixture in fixtures if _is_knockout(fixture)]
    assert len(bracket) == 1
    assert bracket[0].entry_a_id is not None
    assert bracket[0].entry_b_id is not None
    assert bracket[0].match_id is not None

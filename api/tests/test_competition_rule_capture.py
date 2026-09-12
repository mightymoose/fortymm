"""Direct SQL captures the owning event's format rules in either schema path."""

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from app.db import Base
from tests._database_reset import reset_database
from tests._helpers import make_user
from tests._migration_database import empty_database, migrated_database
from tests.test_tournament_draw_service import _make_event, _make_tournament


@pytest.fixture(scope="session", params=["metadata", "alembic"])
async def engine(request, postgres_url):
    if request.param == "metadata":
        async with empty_database(postgres_url) as database:
            async with database.begin() as connection:
                await connection.run_sync(Base.metadata.create_all)
            yield database
    else:
        async with migrated_database(postgres_url) as database:
            await reset_database(database, Base.metadata.sorted_tables)
            yield database


async def test_sql_cannot_capture_a_different_draw_type(db_session, default_league):
    owner = await make_user(db_session, "format-capture-owner")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _make_event(db_session, tournament)
    with pytest.raises(IntegrityError, match="format rules must agree"):
        await db_session.execute(
            text(
                "INSERT INTO tournament_draw_revisions(event_id, format_rules) "
                "VALUES (:event, CAST(:rules AS jsonb))"
            ),
            {
                "event": event.id,
                "rules": '{"version":1,"draw_type":"single-elim","settings":{}}',
            },
        )


async def test_sql_cannot_capture_different_format_settings(db_session, default_league):
    from app.models import TournamentEventDrawSettings
    from app.models.tournament import DrawType

    owner = await make_user(db_session, "format-settings-owner")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _make_event(db_session, tournament, draw_type=DrawType.swiss)
    event.draw_settings = TournamentEventDrawSettings.for_draw_type(
        DrawType.swiss, settings={"rounds": 3}
    )
    await db_session.commit()
    with pytest.raises(IntegrityError, match="format rules must agree"):
        await db_session.execute(
            text(
                "INSERT INTO tournament_draw_revisions(event_id, format_rules) "
                "VALUES (:event, CAST(:rules AS jsonb))"
            ),
            {
                "event": event.id,
                "rules": '{"version":1,"draw_type":"swiss","settings":{"rounds":4}}',
            },
        )


@pytest.mark.parametrize(
    "changed", [{"team_size": 2}, {"best_of": 3}, {"affects_rating": False}]
)
async def test_sql_cannot_capture_different_event_match_rules(
    db_session, default_league, changed
):
    import json

    owner = await make_user(db_session, "match-rules-owner")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _make_event(db_session, tournament)
    rules = {
        "rule_version": 1,
        "team_size": 1,
        "best_of": 5,
        "affects_rating": True,
        "verification_policy": "none",
        "retirement_window": "P7D",
        **changed,
    }
    with pytest.raises(IntegrityError, match="match rules must agree"):
        await db_session.execute(
            text(
                "INSERT INTO tournament_draw_revisions(event_id, match_rules) "
                "VALUES (:event, CAST(:rules AS jsonb))"
            ),
            {"event": event.id, "rules": json.dumps(rules)},
        )


@pytest.mark.parametrize("supplied", [False, True], ids=["autofill", "explicit"])
@pytest.mark.parametrize(
    ("draw_type", "settings", "event_format", "team_size"),
    [
        ("swiss", {"rounds": 3}, "singles", 1),
        ("rr-then-ko", {"qualifiers_per_group": 2}, "doubles", 2),
    ],
)
async def test_sql_captures_matching_rules_and_preserves_policy_overrides(
    db_session, default_league, supplied, draw_type, settings, event_format, team_size
):
    import json

    from app.models import TournamentEventDrawSettings
    from app.models.tournament import DrawType, EventFormat

    owner = await make_user(db_session, "valid-capture-owner")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _make_event(
        db_session,
        tournament,
        draw_type=DrawType(draw_type),
        format=EventFormat(event_format),
    )
    event.draw_settings = TournamentEventDrawSettings.for_draw_type(
        DrawType(draw_type), settings=settings
    )
    await db_session.commit()
    format_rules = {"version": 1, "draw_type": draw_type, "settings": settings}
    match_rules = {
        "rule_version": 1,
        "team_size": team_size,
        "best_of": 5,
        "affects_rating": True,
        "verification_policy": "self_report" if supplied else "none",
        "retirement_window": None if supplied else "P7D",
    }
    captured = (
        await db_session.execute(
            text(
                "INSERT INTO tournament_draw_revisions"
                "(event_id, format_rules, match_rules) "
                "VALUES (:event, CAST(:format AS jsonb), CAST(:match AS jsonb)) "
                "RETURNING format_rules, match_rules"
            ),
            {
                "event": event.id,
                "format": json.dumps(format_rules) if supplied else None,
                "match": json.dumps(match_rules) if supplied else None,
            },
        )
    ).one()
    assert captured.format_rules == format_rules
    assert captured.match_rules == match_rules

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


@pytest.mark.parametrize(
    "rewrite_id", [False, True], ids=["original-id", "rewritten-id"]
)
async def test_source_linked_match_requires_a_fixture_from_its_revision(
    db_session, default_league, rewrite_id
):
    from app.models import Match, MatchSettings

    owner = await make_user(db_session, "forged-match-source")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _make_event(db_session, tournament)
    revision = await db_session.scalar(
        text(
            "INSERT INTO tournament_draw_revisions(event_id) VALUES (:id) RETURNING id"
        ),
        {"id": event.id},
    )
    rules = MatchSettings(
        team_size=1, best_of=5, affects_rating=True, source_rule_revision_id=revision
    )
    match = Match(
        match_settings=rules, league_id=default_league.id, created_by_user_id=owner.id
    )
    db_session.add(match)
    await db_session.flush()
    if rewrite_id:
        await db_session.execute(
            text("UPDATE matches SET id=gen_random_uuid() WHERE id=:id"),
            {"id": match.id},
        )
    with pytest.raises(IntegrityError, match="source revision requires its fixture"):
        await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))


@pytest.mark.parametrize("mutation", ["unlink", "delete", "reassign", "truncate"])
async def test_source_linked_match_cannot_lose_its_fixture(
    db_session, default_league, mutation
):
    from sqlalchemy import select

    from app.models import Match, MatchSettings, TournamentFixture
    from app.tournament_draw_service import cut_event_draw
    from app.tournament_materialization import materialize_event
    from tests._entry_seeds import seed_fixture_match_sides
    from tests.test_tournament_draw_service import _enter_field

    owner = await make_user(db_session, "surviving-source-owner")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    event = await _make_event(db_session, tournament)
    await _enter_field(db_session, event, 4, prefix="surviving-source-field")
    await cut_event_draw(
        db_session, tournament_id=tournament.id, event_id=event.id, actor=owner
    )
    await materialize_event(db_session, tournament, event)
    await db_session.commit()
    fixture = await db_session.scalar(select(TournamentFixture).limit(1))
    replacement = None
    if mutation == "reassign":
        replacement = Match(
            match_settings=MatchSettings(team_size=1, best_of=5, affects_rating=True),
            league_id=default_league.id,
            created_by_user_id=owner.id,
        )
        db_session.add(replacement)
        await db_session.flush()
        await seed_fixture_match_sides(db_session, fixture, replacement)
        await db_session.commit()
    if mutation == "truncate":
        with pytest.raises(
            IntegrityError, match="source revision requires its fixture"
        ):
            await db_session.execute(text("TRUNCATE tournament_fixtures CASCADE"))
        return
    if mutation == "delete":
        await db_session.execute(
            text("DELETE FROM tournament_fixtures WHERE id=:id"), {"id": fixture.id}
        )
    else:
        await db_session.execute(
            text("UPDATE tournament_fixtures SET match_id=:match WHERE id=:id"),
            {"id": fixture.id, "match": replacement.id if replacement else None},
        )
    with pytest.raises(IntegrityError, match="source revision requires its fixture"):
        await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))

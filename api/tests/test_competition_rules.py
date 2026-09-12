"""Rule storage's SQL interface protects historical interpretation."""

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import MatchSettings


async def test_match_rules_are_immutable_from_creation(
    db_session: AsyncSession,
) -> None:
    settings = MatchSettings(team_size=1, best_of=3)
    db_session.add(settings)
    await db_session.flush()
    with pytest.raises(IntegrityError, match="immutable"):
        await db_session.execute(
            text("UPDATE match_settings SET best_of=5 WHERE id=:id"),
            {"id": settings.id},
        )


async def test_sql_cannot_replace_a_match_rules_reference(
    db_session: AsyncSession, default_league
) -> None:
    from app.models import Match
    from tests._helpers import make_user

    owner = await make_user(db_session, "rule-reference-owner")
    original = MatchSettings(team_size=1, best_of=3)
    replacement = MatchSettings(team_size=1, best_of=5)
    match = Match(
        match_settings=original,
        league_id=default_league.id,
        created_by_user_id=owner.id,
    )
    db_session.add_all([match, replacement])
    await db_session.flush()
    with pytest.raises(IntegrityError, match="immutable"):
        await db_session.execute(
            text("UPDATE matches SET match_settings_id=:rules WHERE id=:id"),
            {"rules": replacement.id, "id": match.id},
        )


async def test_each_match_owns_its_own_rule_snapshot(
    db_session: AsyncSession, default_league
) -> None:
    from app.models import Match
    from tests._helpers import make_user

    owner = await make_user(db_session, "rule-owner")
    rules = MatchSettings(team_size=1, best_of=3)
    db_session.add_all(
        [
            Match(
                match_settings=rules,
                league_id=default_league.id,
                created_by_user_id=owner.id,
            )
            for _ in range(2)
        ]
    )
    with pytest.raises(IntegrityError):
        await db_session.flush()


async def test_standalone_match_rules_record_interpretation_version(
    db_session: AsyncSession,
) -> None:
    rules = MatchSettings(team_size=2, best_of=5)
    db_session.add(rules)
    await db_session.flush()
    assert (
        await db_session.scalar(
            text("SELECT rule_version FROM match_settings WHERE id=:id"),
            {"id": rules.id},
        )
        == 1
    )


async def test_later_knockout_match_keeps_cut_rules_after_planning_and_default_changes(
    api_client, db_session: AsyncSession
) -> None:
    from datetime import timedelta

    from sqlalchemy import select

    from app.models import Match, TournamentStatus, VerificationPolicy
    from app.models.draw_type import DRAW_TYPE_IDS
    from app.models.tournament import DrawType
    from tests._helpers import opponent_session, start_session
    from tests.test_tournaments import (
        _call_fixtures,
        _cut_the_draw,
        _enter,
        _fixture_rows,
        _go_live,
        _grant_tournament_perms,
        _se_payload,
        _set_status,
        _tournament_with_events,
        _win_fixture_match,
    )

    client = api_client
    owner = await start_session(client, db_session)
    await _grant_tournament_perms(db_session, owner)
    async with (
        opponent_session(db_session, "frozen-winner") as (winner_client, winner),
        opponent_session(db_session, "frozen-loser") as (loser_client, loser),
    ):
        tid, (event,) = await _tournament_with_events(client, _se_payload())
        await _enter(db_session, event["id"], owner, seed=1)
        winning = await _enter(db_session, event["id"], winner, seed=2)
        losing = await _enter(db_session, event["id"], loser, seed=3)
        await _cut_the_draw(client, tid, event["id"])
        await _set_status(db_session, tid, TournamentStatus.published)
        assert (await _go_live(client, tid)).status_code == 201
        fixtures = await _fixture_rows(db_session, event["id"])
        semifinal = next(f for f in fixtures if f.round == 1)
        final = next(f for f in fixtures if f.round == 2)
        await _call_fixtures(db_session, tid, [semifinal])
        await db_session.execute(
            text(
                "UPDATE tournament_events SET match_settings=CAST(:settings AS jsonb), "
                "draw_type_id=:type WHERE id=:id"
            ),
            {
                "type": DRAW_TYPE_IDS[DrawType.round_robin],
                "id": event["id"],
                "settings": '{"rated": false, "length_games": 1}',
            },
        )
        await db_session.execute(
            text(
                "ALTER TABLE match_settings ALTER COLUMN "
                "verification_policy SET "
                "DEFAULT 'self_report'"
            )
        )
        await db_session.execute(
            text(
                "ALTER TABLE match_settings ALTER COLUMN retirement_window SET "
                "DEFAULT '1 day'"
            )
        )
        await db_session.commit()
        try:
            await _win_fixture_match(
                semifinal,
                clients_by_entry={winning.id: winner_client, losing.id: loser_client},
                winner_entry_id=winning.id,
                rated=True,
            )
            await db_session.refresh(final)
            assert final.match_id is not None
            rules = (
                await db_session.scalars(
                    select(MatchSettings).join(Match).where(Match.id == final.match_id)
                )
            ).one()
            assert rules.best_of == 3
            assert rules.affects_rating is True
            assert rules.verification_policy is VerificationPolicy.none
            assert rules.retirement_window == timedelta(days=7)
        finally:
            await db_session.rollback()
            await db_session.execute(
                text(
                    "ALTER TABLE match_settings ALTER COLUMN "
                    "verification_policy SET "
                    "DEFAULT 'none'"
                )
            )
            await db_session.execute(
                text(
                    "ALTER TABLE match_settings ALTER COLUMN retirement_window SET "
                    "DEFAULT '7 days'"
                )
            )
            await db_session.commit()


def test_unknown_format_interpretation_is_not_dispatched_as_current() -> None:
    from app.draws import strategy_for
    from app.models import DrawType
    from app.results import results_for
    from app.schemas.tournament import RoundRobinDrawSettingsWrite

    with pytest.raises(ValueError, match="Unsupported.*version"):
        strategy_for(RoundRobinDrawSettingsWrite(), version=99)
    with pytest.raises(ValueError, match="Unsupported.*version"):
        results_for(DrawType.round_robin, version=99)


async def test_explicit_absence_of_retirement_window_is_preserved(
    db_session: AsyncSession,
) -> None:
    rules = MatchSettings(team_size=1, best_of=3, retirement_window=None)
    db_session.add(rules)
    await db_session.flush()
    await db_session.refresh(rules)
    assert rules.retirement_window is None


async def test_materialization_preserves_a_disabled_retirement_policy(
    db_session: AsyncSession,
) -> None:
    from sqlalchemy import select

    from app.models import Match, Tournament, TournamentEvent, TournamentFixture
    from app.tournament_materialization import materialize_event
    from tests._helpers import directed_tournament_match

    source, _ = await directed_tournament_match(
        db_session, tag="no-retirement", retirement_window=None
    )
    fixture = (
        await db_session.scalars(
            select(TournamentFixture).where(TournamentFixture.match_id == source.id)
        )
    ).one()
    event = (
        await db_session.scalars(
            select(TournamentEvent).where(TournamentEvent.id == fixture.scope_event_id)
        )
    ).one()
    tournament = await db_session.get(Tournament, event.tournament_id)
    ready = TournamentFixture(
        stage_id=fixture.stage_id,
        group_id=fixture.group_id,
        round=2,
        position=1,
        entry_a_id=fixture.entry_a_id,
        entry_b_id=fixture.entry_b_id,
    )
    db_session.add(ready)
    await db_session.flush()
    await materialize_event(db_session, tournament, event)
    await db_session.flush()
    assert ready.match_id is not None
    rules = (
        await db_session.scalars(
            select(MatchSettings).join(Match).where(Match.id == ready.match_id)
        )
    ).one()
    assert rules.retirement_window is None

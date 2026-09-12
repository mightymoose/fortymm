"""Raw SQL advancement invariants on both ORM and fresh Alembic schemas."""

from app.models import TournamentFixture
from app.result_proposal import propose_result
from tests._advancement_seeds import seed_knockout_advancement as knockout
from tests.test_entry_members import entry_schema as entry_schema
from tests.test_entry_members import postgres_url as postgres_url
from tests.test_official_results import board


async def test_sql_cannot_rewrite_or_delete_advancement_history(db_session):
    import pytest
    from sqlalchemy import text
    from sqlalchemy.exc import IntegrityError

    from app.advancement_decisions import advancement_history

    match, director, _, target = await knockout(db_session)
    await propose_result(
        db_session, match.id, director.id, games=board(), supersedes_result_id=None
    )
    (decision,) = await advancement_history(db_session, target.id, "a")
    for statement in (
        "UPDATE fixture_advancement_decisions SET rule_version = "
        "'rewritten' WHERE id = :id",
        "DELETE FROM advancement_decision_evidence WHERE decision_id = :id",
        "UPDATE advancement_decision_evidence SET official_result_id = "
        "official_result_id WHERE decision_id = :id",
        "DELETE FROM fixture_advancement_decisions WHERE id = :id",
    ):
        with pytest.raises(IntegrityError):
            async with db_session.begin_nested():
                await db_session.execute(text(statement), {"id": decision.id})
                await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))


async def test_sql_cannot_commit_a_decision_without_its_required_evidence(db_session):
    import pytest
    from sqlalchemy import text
    from sqlalchemy.exc import IntegrityError

    from app.advancement_decisions import advancement_history

    match, director, source, target = await knockout(db_session)
    await propose_result(
        db_session, match.id, director.id, games=board(), supersedes_result_id=None
    )
    (decision,) = await advancement_history(db_session, target.id, "a")
    other_target = TournamentFixture(
        stage_id=source.stage_id,
        group_id=source.group_id,
        round=3,
        position=1,
        entry_a_id=source.entry_a_id,
    )
    db_session.add(other_target)
    await db_session.commit()
    with pytest.raises(IntegrityError, match="evidence"):
        async with db_session.begin_nested():
            await db_session.execute(
                text("""
                INSERT INTO fixture_advancement_decisions
                    (fixture_id, side, entry_id, source_fixture_id, rule_version,
                        rule_settings)
                SELECT :target, side, entry_id, source_fixture_id, rule_version,
                    rule_settings
                FROM fixture_advancement_decisions WHERE id = :id
            """),
                {"target": other_target.id, "id": decision.id},
            )
            await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))


async def test_current_decision_must_continue_to_govern_the_seat(db_session):
    import pytest
    from sqlalchemy import text
    from sqlalchemy.exc import IntegrityError

    match, director, source, target = await knockout(db_session)
    await propose_result(
        db_session, match.id, director.id, games=board(), supersedes_result_id=None
    )
    with pytest.raises(IntegrityError, match="advancement.*seat"):
        async with db_session.begin_nested():
            await db_session.execute(
                text(
                    "UPDATE tournament_fixtures SET entry_a_id = :entry WHERE id = :id"
                ),
                {"entry": source.entry_b_id, "id": target.id},
            )
            await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))


async def test_sql_rejects_source_from_another_event(db_session):
    import pytest
    from sqlalchemy import text
    from sqlalchemy.exc import IntegrityError

    from app.advancement_decisions import advancement_history

    match, director, source, target = await knockout(db_session)
    _, _, foreign_source, _ = await knockout(db_session, "foreign")
    await propose_result(
        db_session, match.id, director.id, games=board(), supersedes_result_id=None
    )
    (decision,) = await advancement_history(db_session, target.id, "a")
    other_target = TournamentFixture(
        stage_id=source.stage_id,
        group_id=source.group_id,
        round=3,
        position=1,
        entry_a_id=source.entry_a_id,
    )
    db_session.add(other_target)
    await db_session.commit()
    with pytest.raises(IntegrityError, match="advancement.*source"):
        async with db_session.begin_nested():
            new_id = (
                await db_session.execute(
                    text("""
                INSERT INTO fixture_advancement_decisions
                    (fixture_id, side, entry_id, source_fixture_id, rule_version,
                        rule_settings)
                SELECT :target, side, entry_id, :source, rule_version, rule_settings
                FROM fixture_advancement_decisions WHERE id = :id RETURNING id
            """),
                    {
                        "target": other_target.id,
                        "source": foreign_source.id,
                        "id": decision.id,
                    },
                )
            ).scalar_one()
            await db_session.execute(
                text("""INSERT INTO advancement_decision_evidence
                SELECT :new, match_id, official_result_id
                    FROM advancement_decision_evidence WHERE decision_id = :id
                    """),
                {"new": new_id, "id": decision.id},
            )
            await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))


async def test_sql_replacements_require_linear_revision_actor_and_reason(db_session):
    import pytest
    from sqlalchemy import text
    from sqlalchemy.exc import IntegrityError

    from app.advancement_decisions import advancement_history

    match, director, _, target = await knockout(db_session)
    await propose_result(
        db_session, match.id, director.id, games=board(), supersedes_result_id=None
    )
    (decision,) = await advancement_history(db_session, target.id, "a")
    for revision, actor, reason in [
        (3, director.id, "Reaffirm"),
        (2, None, "Reaffirm"),
        (2, director.id, "  "),
    ]:
        with pytest.raises(IntegrityError):
            async with db_session.begin_nested():
                new_id = (
                    await db_session.execute(
                        text("""
                    INSERT INTO fixture_advancement_decisions
                    (fixture_id, side, entry_id, source_fixture_id, rule_version,
                        rule_settings,
                     revision, predecessor_id, actor_account_id, reason)
                    SELECT fixture_id, side, entry_id, source_fixture_id, rule_version,
                        rule_settings,
                           :revision, id, :actor, :reason
                    FROM fixture_advancement_decisions WHERE id = :id RETURNING id
                """),
                        {
                            "id": decision.id,
                            "revision": revision,
                            "actor": actor,
                            "reason": reason,
                        },
                    )
                ).scalar_one()
                await db_session.execute(
                    text("""INSERT INTO advancement_decision_evidence
                    SELECT :new, match_id, official_result_id
                    FROM advancement_decision_evidence WHERE decision_id = :id
                    """),
                    {"new": new_id, "id": decision.id},
                )
                await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))


async def test_retained_unknown_decision_prevents_moving_its_fixture_to_another_event(
    db_session,
):
    import pytest
    from sqlalchemy import text
    from sqlalchemy.exc import IntegrityError

    from app.models import AdvancementDecision, TournamentEntry, TournamentEntryStatus

    _, _, source, target = await knockout(db_session)
    _, _, foreign, _ = await knockout(db_session, "foreign")
    entrant = TournamentEntry(
        event_id=source.scope_event_id, status=TournamentEntryStatus.withdrawn
    )
    db_session.add(entrant)
    await db_session.flush()
    target.entry_a_id = entrant.id
    db_session.add(
        AdvancementDecision(
            fixture_id=target.id,
            side="a",
            entry_id=entrant.id,
            rule_version="unknown",
            rule_settings={},
            evidence_count=0,
            unknown_reason="Seeded bracket without original evidence",
        )
    )
    await db_session.commit()
    with pytest.raises(IntegrityError, match="advancement.*ownership"):
        async with db_session.begin_nested():
            await db_session.execute(
                text(
                    "UPDATE tournament_fixtures SET stage_id = :stage, group_id = "
                    ":group, round = 3 WHERE id = :id"
                ),
                {"stage": foreign.stage_id, "group": foreign.group_id, "id": target.id},
            )
            await db_session.execute(
                text("UPDATE tournament_entries SET event_id = :event WHERE id = :id"),
                {"event": foreign.scope_event_id, "id": entrant.id},
            )
            await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))


async def test_unknown_provenance_requires_a_nonblank_reason(db_session):
    import pytest
    from sqlalchemy.exc import IntegrityError

    from app.models import AdvancementDecision

    _, _, source, target = await knockout(db_session)
    target.entry_a_id = source.entry_a_id
    await db_session.commit()
    with pytest.raises(IntegrityError):
        async with db_session.begin_nested():
            db_session.add(
                AdvancementDecision(
                    fixture_id=target.id,
                    side="a",
                    entry_id=source.entry_a_id,
                    rule_version="unknown",
                    rule_settings={},
                    evidence_count=0,
                    unknown_reason="  ",
                )
            )
            await db_session.flush()


async def test_database_rejects_settings_that_do_not_describe_the_recorded_rule(
    db_session,
):
    import pytest
    from sqlalchemy.exc import IntegrityError

    from app.models import AdvancementDecision

    _, _, source, target = await knockout(db_session)
    target.entry_a_id = source.entry_a_id
    await db_session.commit()
    with pytest.raises(IntegrityError, match="settings"):
        async with db_session.begin_nested():
            db_session.add(
                AdvancementDecision(
                    fixture_id=target.id,
                    side="a",
                    entry_id=source.entry_a_id,
                    rule_version="unknown",
                    rule_settings={"invented": "setting"},
                    evidence_count=0,
                    unknown_reason="Unavailable imported evidence",
                )
            )
            await db_session.flush()


async def test_sql_cannot_create_a_self_linked_history_revision(db_session):
    import uuid

    import pytest
    from sqlalchemy import text
    from sqlalchemy.exc import IntegrityError

    from app.advancement_decisions import advancement_history

    match, director, _, target = await knockout(db_session)
    await propose_result(
        db_session, match.id, director.id, games=board(), supersedes_result_id=None
    )
    (original,) = await advancement_history(db_session, target.id, "a")
    with pytest.raises(IntegrityError):
        async with db_session.begin_nested():
            new_id = uuid.uuid4()
            await db_session.execute(
                text("""
                INSERT INTO fixture_advancement_decisions
                (id, fixture_id, side, entry_id, source_fixture_id, rule_version,
                 rule_settings, revision, predecessor_id, actor_account_id, reason)
                SELECT :new, fixture_id, side, entry_id, source_fixture_id,
                       rule_version, rule_settings, 2, :new, :actor, 'Self reference'
                FROM fixture_advancement_decisions WHERE id = :id
            """),
                {"new": new_id, "id": original.id, "actor": director.id},
            )
            await db_session.execute(
                text("""
                INSERT INTO advancement_decision_evidence
                SELECT :new, match_id, official_result_id
                FROM advancement_decision_evidence WHERE decision_id = :id
            """),
                {"new": new_id, "id": original.id},
            )
            await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))

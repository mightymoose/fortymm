"""SQL result authority reflects live Accounts while retaining historical actors."""

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from app.match_creation import create_match
from app.models import MatchResult
from app.models.official_result import OfficialResult
from tests._helpers import make_user


async def solo_proposal(db_session):
    actor = await make_user(db_session, "sql-result-actor")
    match = await create_match(
        db_session,
        creator=actor,
        opponent_user_id=None,
        league_id=None,
        best_of=1,
        rated=False,
    )
    proposal = MatchResult(
        match_id=match.id,
        submitted_by_user_id=actor.id,
        submitted_for_player_id=actor.id,
        games=[{"game_number": 1, "side_1_points": 11, "side_2_points": 4}],
    )
    return actor, match, proposal


@pytest.mark.parametrize("erased", [False, True])
async def test_inactive_sql_proposal_cannot_claim_participant_authority(
    db_session, erased
):
    actor, _, proposal = await solo_proposal(db_session)
    await db_session.execute(
        text("UPDATE accounts SET deactivated_at=clock_timestamp() WHERE id=:id"),
        {"id": actor.id},
    )
    if erased:
        from app.identity_lifecycle import erase_account

        await erase_account(db_session, actor.id)
        await db_session.flush()
    proposal.participant_authorized = True
    db_session.add(proposal)
    await db_session.flush()
    await db_session.refresh(proposal)
    assert proposal.participant_authorized is False


@pytest.mark.parametrize("erased", [False, True])
async def test_inactive_sql_actor_cannot_finalize_historical_proposal(
    db_session, erased
):
    from app.identity_lifecycle import deactivate_account, erase_account

    actor, match, proposal = await solo_proposal(db_session)
    db_session.add(proposal)
    await db_session.flush()
    await db_session.refresh(proposal)
    assert proposal.participant_authorized
    if erased:
        await erase_account(db_session, actor.id)
    else:
        await deactivate_account(db_session, actor.id)
    await db_session.flush()
    with pytest.raises(IntegrityError, match="official actor must be active"):
        async with db_session.begin_nested():
            db_session.add(
                OfficialResult(
                    match_id=match.id,
                    revision=1,
                    proposal_id=proposal.id,
                    resolution_method="immediate_finalization",
                    actor_account_id=actor.id,
                    games=proposal.games,
                )
            )
            await db_session.flush()
    await db_session.refresh(proposal)
    assert proposal.participant_authorized
    assert proposal.submitted_by_user_id == actor.id


@pytest.mark.parametrize("operation", ["proposal", "finalization"])
async def test_sql_result_authority_retries_concurrent_account_deactivation(
    db_session, operation
):
    from sqlalchemy.exc import DBAPIError
    from sqlalchemy.ext.asyncio import async_sessionmaker

    actor, match, proposal = await solo_proposal(db_session)
    if operation == "finalization":
        db_session.add(proposal)
        await db_session.flush()
    await db_session.commit()
    sessions = async_sessionmaker(db_session.bind, expire_on_commit=False)
    async with sessions() as lifecycle:
        await lifecycle.execute(
            text("UPDATE accounts SET deactivated_at=clock_timestamp() WHERE id=:id"),
            {"id": actor.id},
        )
        try:
            with pytest.raises(DBAPIError, match="retry") as error:
                async with db_session.begin_nested():
                    if operation == "proposal":
                        db_session.add(proposal)
                    else:
                        db_session.add(
                            OfficialResult(
                                match_id=match.id,
                                revision=1,
                                proposal_id=proposal.id,
                                resolution_method="immediate_finalization",
                                actor_account_id=actor.id,
                                games=proposal.games,
                            )
                        )
                    await db_session.flush()
            assert error.value.orig.sqlstate == "40001"
        finally:
            await lifecycle.rollback()


async def consent_proposal(db_session):
    proposer = await make_user(db_session, "sql-consent-proposer")
    acceptor = await make_user(db_session, "sql-consent-acceptor")
    match = await create_match(
        db_session,
        creator=proposer,
        opponent_user_id=acceptor.id,
        league_id=None,
        best_of=1,
        rated=False,
    )
    proposal = MatchResult(
        match_id=match.id,
        submitted_by_user_id=proposer.id,
        submitted_for_player_id=proposer.id,
        games=[{"game_number": 1, "side_1_points": 11, "side_2_points": 4}],
    )
    return acceptor, proposal


@pytest.mark.parametrize("operation", ["insert", "update"])
@pytest.mark.parametrize("erased", [False, True])
async def test_sql_cannot_record_new_consent_from_inactive_actor(
    db_session, operation, erased
):
    from datetime import UTC, datetime

    from app.identity_lifecycle import deactivate_account, erase_account

    acceptor, proposal = await consent_proposal(db_session)
    if operation == "update":
        db_session.add(proposal)
        await db_session.flush()
    if erased:
        await erase_account(db_session, acceptor.id)
    else:
        await deactivate_account(db_session, acceptor.id)
    await db_session.flush()
    with pytest.raises(IntegrityError, match="consent actor must be active"):
        async with db_session.begin_nested():
            proposal.accepted_by_user_id = acceptor.id
            proposal.accepted_at = datetime.now(UTC)
            db_session.add(proposal)
            await db_session.flush()


@pytest.mark.parametrize("operation", ["insert", "update"])
async def test_sql_consent_retries_concurrent_acceptor_deactivation(
    db_session, operation
):
    from datetime import UTC, datetime

    from sqlalchemy.exc import DBAPIError
    from sqlalchemy.ext.asyncio import async_sessionmaker

    acceptor, proposal = await consent_proposal(db_session)
    if operation == "update":
        db_session.add(proposal)
        await db_session.flush()
    await db_session.commit()
    sessions = async_sessionmaker(db_session.bind, expire_on_commit=False)
    async with sessions() as lifecycle:
        await lifecycle.execute(
            text("UPDATE accounts SET deactivated_at=clock_timestamp() WHERE id=:id"),
            {"id": acceptor.id},
        )
        try:
            with pytest.raises(DBAPIError, match="retry") as error:
                async with db_session.begin_nested():
                    proposal.accepted_by_user_id = acceptor.id
                    proposal.accepted_at = datetime.now(UTC)
                    db_session.add(proposal)
                    await db_session.flush()
            assert error.value.orig.sqlstate == "40001"
        finally:
            await lifecycle.rollback()


@pytest.mark.parametrize("erased", [False, True])
async def test_existing_sql_consent_survives_acceptor_lifecycle(db_session, erased):
    from datetime import UTC, datetime

    from app.identity_lifecycle import deactivate_account, erase_account

    acceptor, proposal = await consent_proposal(db_session)
    proposal.accepted_by_user_id = acceptor.id
    proposal.accepted_at = datetime.now(UTC)
    db_session.add(proposal)
    await db_session.commit()
    original_consent = proposal.accepted_at
    if erased:
        await erase_account(db_session, acceptor.id)
    else:
        await deactivate_account(db_session, acceptor.id)
    await db_session.commit()
    # A harmless update must not reinterpret or invalidate retained consent.
    await db_session.execute(
        text("UPDATE match_results SET accepted_at=accepted_at WHERE id=:id"),
        {"id": proposal.id},
    )
    await db_session.commit()
    await db_session.refresh(proposal)
    assert proposal.accepted_by_user_id == acceptor.id
    assert proposal.accepted_at == original_consent

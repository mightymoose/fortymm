"""Stable identities cannot be removed, even without sporting references."""

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from app.models import Account, Player


@pytest.mark.parametrize("model,table", [(Account, "accounts"), (Player, "players")])
async def test_unused_identity_cannot_be_deleted(db_session, model, table):
    identity = model() if model is Account else model(username="retained-player")
    db_session.add(identity)
    await db_session.commit()
    with pytest.raises(IntegrityError, match="identities must be retained"):
        async with db_session.begin_nested():
            await db_session.execute(
                text(f"DELETE FROM {table} WHERE id = :id"), {"id": identity.id}
            )


async def test_deactivation_revokes_authority_without_retiring_player(db_session):
    from app.identity_lifecycle import deactivate_account, reactivate_account
    from app.player_accounts import PlayerAccessDenied, require_player

    account = Account(username="returning-player", email="returning@example.com")
    db_session.add(account)
    await db_session.commit()
    player_id = account.player_id
    await deactivate_account(db_session, account.id)
    await db_session.commit()
    assert account.email == "returning@example.com"
    assert account.primary_player.retired_at is None
    with pytest.raises(PlayerAccessDenied):
        await require_player(db_session, account.id, player_id)
    await reactivate_account(db_session, account.id)
    await db_session.commit()
    assert (await require_player(db_session, account.id, player_id)).id == player_id


async def test_deactivated_account_cannot_authenticate_with_auth0(db_session):
    from app.auth0_identity import resolve_linked_user
    from app.auth0_provisioning import resolve_or_provision_user
    from app.identity_lifecycle import deactivate_account

    account = Account(email="inactive@example.com", auth0_sub="auth0|inactive")
    db_session.add(account)
    await db_session.commit()
    await deactivate_account(db_session, account.id)
    await db_session.commit()
    assert await resolve_linked_user(db_session, "auth0|inactive") is None
    assert (
        await resolve_or_provision_user(
            db_session, "auth0|inactive", "inactive@example.com", True
        )
        is None
    )


async def test_deactivation_denies_existing_sessions_and_email_actions(db_session):
    from app.email_credentials import email_action_is_valid
    from app.models.user_token import EmailPurpose, EmailToken, SessionToken
    from app.sessions import get_optional_user, hash_token

    account = Account(email="offline@example.com")
    db_session.add(account)
    await db_session.flush()
    db_session.add(SessionToken(user_id=account.id, token=hash_token("old-cookie")))
    await db_session.commit()
    await db_session.execute(
        text("UPDATE accounts SET deactivated_at=clock_timestamp() WHERE id=:id"),
        {"id": account.id},
    )
    await db_session.commit()
    await db_session.refresh(account)
    assert await get_optional_user(session_cookie="old-cookie", db=db_session) is None
    assert not await email_action_is_valid(
        db_session,
        EmailToken(
            user_id=account.id, purpose=EmailPurpose.login, sent_to=account.email
        ),
    )


async def test_erasure_scrubs_login_identity_without_reclaiming_player(db_session):
    from sqlalchemy import select

    from app.auth0_provisioning import resolve_or_provision_user
    from app.identity_lifecycle import (
        IdentityLifecycleError,
        erase_account,
        reactivate_account,
    )
    from app.models import LoginIdentity
    from app.player_accounts import require_player

    account = Account(
        username="retained-sport", email="erased@example.com", auth0_sub="auth0|erased"
    )
    db_session.add(account)
    await db_session.commit()
    account_id, player_id = account.id, account.player_id
    await erase_account(db_session, account_id)
    await db_session.commit()
    assert account.email is None
    assert account.display_name == "Erased account"
    assert (
        await db_session.scalar(
            select(LoginIdentity).where(LoginIdentity.account_id == account_id)
        )
        is None
    )
    assert await db_session.get(Player, player_id) is not None
    with pytest.raises(IdentityLifecycleError):
        await reactivate_account(db_session, account_id)
    returning = await resolve_or_provision_user(
        db_session, "auth0|erased", "erased@example.com", True
    )
    assert returning is not None and returning.id != account_id
    from app.player_accounts import PlayerAccessDenied

    with pytest.raises(PlayerAccessDenied):
        await require_player(db_session, returning.id, player_id)


async def test_retirement_hides_player_and_restoration_preserves_identity(db_session):
    from datetime import UTC, datetime

    from app.identity_lifecycle import restore_player, retire_player
    from app.player_accounts import PlayerAccessDenied, require_player
    from app.player_search import search_players_by_username

    account = Account(username="retirement-search", last_seen_at=datetime.now(UTC))
    db_session.add(account)
    await db_session.commit()
    player_id = account.player_id
    assert (
        len(
            await search_players_by_username(
                db_session, query="retirement", current_user_id=None
            )
        )
        == 1
    )
    await retire_player(db_session, player_id)
    await db_session.commit()
    assert (
        await search_players_by_username(
            db_session, query="retirement", current_user_id=None
        )
        == []
    )
    with pytest.raises(PlayerAccessDenied):
        await require_player(db_session, account.id, player_id)
    await restore_player(db_session, player_id)
    await db_session.commit()
    assert (
        await require_player(db_session, account.id, player_id)
    ).username == "retirement-search"
    assert (
        len(
            await search_players_by_username(
                db_session, query="retirement", current_user_id=None
            )
        )
        == 1
    )


async def test_deactivated_owner_cannot_direct_or_grant_authority(
    db_session, default_league
):
    from app.identity_lifecycle import deactivate_account, reactivate_account
    from app.models import Tournament
    from app.tournament_authority import can_direct, grant_director
    from app.tournament_errors import NotTournamentOwnerError

    owner = Account(username="inactive-owner")
    director = Account(username="active-director")
    db_session.add_all([owner, director])
    await db_session.flush()
    tournament = Tournament(
        name="Retained ownership",
        league_id=default_league.id,
        created_by_user_id=owner.id,
    )
    db_session.add(tournament)
    await db_session.commit()
    await deactivate_account(db_session, owner.id)
    await db_session.commit()
    assert not await can_direct(db_session, tournament, owner.id)
    with pytest.raises((NotTournamentOwnerError, ValueError)):
        await grant_director(
            db_session, tournament.id, actor_id=owner.id, account_id=director.id
        )
    await reactivate_account(db_session, owner.id)
    await db_session.commit()
    assert await can_direct(db_session, tournament, owner.id)


async def test_database_authority_rejects_inactive_accounts(db_session, default_league):
    from app.identity_lifecycle import deactivate_account
    from app.models import Tournament
    from app.models.tournament_account_grant import TournamentAccountGrant

    owner = Account(username="sql-owner")
    director = Account(username="sql-director")
    db_session.add_all([owner, director])
    await db_session.flush()
    tournament = Tournament(
        name="SQL authority", league_id=default_league.id, created_by_user_id=owner.id
    )
    db_session.add(tournament)
    await db_session.commit()
    await deactivate_account(db_session, owner.id)
    await deactivate_account(db_session, director.id)
    await db_session.commit()
    assert not await db_session.scalar(
        text("SELECT tournament_can_direct(:t, :a)"),
        {"t": tournament.id, "a": owner.id},
    )
    with pytest.raises(IntegrityError, match="recipient must be active"):
        async with db_session.begin_nested():
            db_session.add(
                TournamentAccountGrant(
                    tournament_id=tournament.id,
                    account_id=director.id,
                    granted_by_account_id=owner.id,
                )
            )
            await db_session.flush()


async def test_retired_player_cannot_be_selected_for_a_new_match(db_session):
    from app.identity_lifecycle import retire_player
    from app.match_creation import OpponentNotFoundError, create_match

    creator, opponent = (
        Account(username="match-creator"),
        Account(username="retired-opponent"),
    )
    db_session.add_all([creator, opponent])
    await db_session.commit()
    await retire_player(db_session, opponent.player_id)
    await db_session.commit()
    with pytest.raises(OpponentNotFoundError):
        await create_match(
            db_session,
            creator=creator,
            opponent_user_id=opponent.player_id,
            league_id=None,
            best_of=3,
            rated=False,
        )


async def test_inactive_auth0_binding_cannot_provision_under_changed_email(db_session):
    from app.auth0_provisioning import resolve_or_provision_user
    from app.identity_lifecycle import deactivate_account

    account = Account(email="before@example.com", auth0_sub="auth0|same-person")
    db_session.add(account)
    await db_session.commit()
    await deactivate_account(db_session, account.id)
    await db_session.commit()
    assert (
        await resolve_or_provision_user(
            db_session, "auth0|same-person", "after@example.com", True
        )
        is None
    )


async def test_inactive_account_cannot_transfer_identity_through_merge(db_session):
    from app.account_merge import merge_user
    from app.identity_lifecycle import deactivate_account

    source = Account(username="inactive-merge-source")
    target = Account(username="active-merge-target")
    db_session.add_all([source, target])
    await db_session.commit()
    await deactivate_account(db_session, source.id)
    await db_session.commit()
    with pytest.raises(ValueError, match="inactive"):
        await merge_user(db_session, from_user_id=source.id, to_user_id=target.id)


async def test_erased_account_cannot_be_revived_through_sql(db_session):
    from app.identity_lifecycle import erase_account

    account = Account(email="sql-erasure@example.com")
    db_session.add(account)
    await db_session.commit()
    await erase_account(db_session, account.id)
    await db_session.commit()
    for change in (
        "erased_at = NULL, deactivated_at = NULL",
        "email = 'revived@example.com'",
    ):
        with pytest.raises(IntegrityError, match="erased identity must remain inert"):
            async with db_session.begin_nested():
                await db_session.execute(
                    text(f"UPDATE accounts SET {change} WHERE id = :id"),
                    {"id": account.id},
                )


async def test_retired_username_cannot_be_released_by_renaming(db_session):
    from app.identity_lifecycle import restore_player, retire_player

    player = Player(username="reserved-through-retirement")
    db_session.add(player)
    await db_session.commit()
    player_id = player.id
    await retire_player(db_session, player_id)
    await db_session.commit()
    with pytest.raises(IntegrityError, match="reserved"):
        async with db_session.begin_nested():
            await db_session.execute(
                text("UPDATE players SET username='released-name' WHERE id=:id"),
                {"id": player_id},
            )
    await restore_player(db_session, player_id)
    await db_session.commit()
    assert (
        await db_session.get(Player, player_id)
    ).username == "reserved-through-retirement"


async def test_tournament_creation_rejects_actor_deactivated_since_authentication(
    db_session,
):
    from app.identity_lifecycle import deactivate_account
    from app.tournament_errors import InactiveTournamentActorError
    from app.tournament_lifecycle import create_tournament
    from tests._helpers import make_user
    from tests.test_tournament_lifecycle import _GEOCODER, _payload

    actor = await make_user(db_session, "inactive-create-owner")
    await deactivate_account(db_session, actor.id)
    await db_session.commit()
    with pytest.raises(InactiveTournamentActorError):
        await create_tournament(
            db_session, actor=actor, payload=_payload(), geocoder=_GEOCODER
        )


async def test_normal_login_link_cannot_authenticate_an_inactive_account(
    api_client, db_session
):
    from app.identity_lifecycle import reactivate_account
    from tests._helpers import make_user
    from tests.test_login import _issue_login_token

    account = await make_user(db_session, "inactive-email-login")
    account.email = "inactive-login@example.com"
    await _issue_login_token(db_session, account, "inactive-old-link")
    await db_session.execute(
        text("UPDATE accounts SET deactivated_at=clock_timestamp() WHERE id=:id"),
        {"id": account.id},
    )
    await db_session.commit()
    denied = await api_client.post(
        "/v1/login/consume", json={"token": "inactive-old-link"}
    )
    assert denied.status_code == 400, denied.text
    await reactivate_account(db_session, account.id)
    await db_session.commit()
    denied = await api_client.post(
        "/v1/login/consume", json={"token": "inactive-old-link"}
    )
    assert denied.status_code == 400, denied.text


async def test_erasure_cannot_retain_a_session_credential_at_commit(db_session):
    from app.models.user_token import SessionToken

    account = Account()
    db_session.add(account)
    await db_session.flush()
    db_session.add(SessionToken(user_id=account.id, token=b"retained-erased-session"))
    await db_session.commit()
    with pytest.raises(IntegrityError, match="erased account credentials"):
        async with db_session.begin_nested():
            await db_session.execute(
                text(
                    "UPDATE accounts SET erased_at=clock_timestamp(), "
                    "deactivated_at=clock_timestamp(), display_name='Erased account' "
                    "WHERE id=:id"
                ),
                {"id": account.id},
            )
            await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))


@pytest.mark.parametrize("operation", ["insert", "reparent"])
@pytest.mark.parametrize(
    "table,column,columns,values",
    [
        (
            "login_identities",
            "account_id",
            "id,account_id,issuer,provider,subject",
            "gen_random_uuid(),:account,'retention','auth0','subject'",
        ),
        (
            "account_session_tokens",
            "user_id",
            "id,user_id,token",
            "gen_random_uuid(),:account,decode('abcd','hex')",
        ),
        (
            "account_email_tokens",
            "user_id",
            "id,user_id,purpose,token,sent_to",
            "gen_random_uuid(),:account,'login',decode('abcd','hex'),'person@example.com'",
        ),
        (
            "account_email_tokens",
            "target_account_id",
            "id,user_id,target_account_id,purpose,token,sent_to",
            "gen_random_uuid(),:other,:account,'merge',decode('abcd','hex'),'person@example.com'",
        ),
        (
            "account_email_tokens",
            "guest_account_id",
            "id,user_id,guest_account_id,purpose,token,sent_to",
            "gen_random_uuid(),:other,:account,'login',decode('abcd','hex'),'person@example.com'",
        ),
        (
            "account_email_intents",
            "user_id",
            "user_id,purpose,sent_to",
            ":account,'change','person@example.com'",
        ),
        (
            "account_email_intents",
            "target_account_id",
            "user_id,target_account_id,purpose,sent_to",
            ":other,:account,'merge','person@example.com'",
        ),
        (
            "account_first_sign_in_intents",
            "user_id",
            "user_id,email",
            ":account,'person@example.com'",
        ),
        (
            "device_tokens",
            "user_id",
            "id,user_id,token,platform,environment",
            "gen_random_uuid(),:account,'device','ios','sandbox'",
        ),
    ],
)
async def test_credentials_cannot_reference_erased_accounts(
    db_session, operation, table, column, columns, values
):
    from app.identity_lifecycle import erase_account

    erased, active, other = Account(), Account(), Account()
    db_session.add_all([erased, active, other])
    await db_session.commit()
    await erase_account(db_session, erased.id)
    await db_session.commit()
    insert = text(f"INSERT INTO {table} ({columns}) VALUES ({values})")
    if operation == "reparent":
        await db_session.execute(insert, {"account": active.id, "other": other.id})
        await db_session.commit()
    with pytest.raises(IntegrityError, match="erased account credentials"):
        async with db_session.begin_nested():
            if operation == "insert":
                await db_session.execute(
                    insert, {"account": erased.id, "other": other.id}
                )
            else:
                await db_session.execute(
                    text(f"UPDATE {table} SET {column}=:erased WHERE {column}=:active"),
                    {"erased": erased.id, "active": active.id},
                )
            await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))


@pytest.mark.parametrize("first", ["erasure", "credential"])
async def test_erasure_serializes_with_concurrent_credential_attachment(
    db_session, engine, first
):
    import asyncio

    from sqlalchemy.ext.asyncio import async_sessionmaker

    account = Account()
    db_session.add(account)
    await db_session.commit()
    account_id = account.id
    sessions = async_sessionmaker(engine)
    async with sessions() as eraser, sessions() as issuer:
        erase_pid = await eraser.scalar(text("SELECT pg_backend_pid()"))
        issue_pid = await issuer.scalar(text("SELECT pg_backend_pid()"))
        erase = text(
            "UPDATE accounts SET erased_at=clock_timestamp(), "
            "deactivated_at=clock_timestamp(), display_name='Erased account' "
            "WHERE id=:id"
        )
        issue = text(
            "INSERT INTO account_session_tokens(id,user_id,token) "
            "VALUES(gen_random_uuid(),:id,decode('abef','hex'))"
        )
        if first == "erasure":
            await eraser.execute(erase, {"id": account_id})
            waiting = asyncio.create_task(issuer.execute(issue, {"id": account_id}))
            blocker, blocked = erase_pid, issue_pid
        else:
            await issuer.execute(issue, {"id": account_id})
            waiting = asyncio.create_task(eraser.execute(erase, {"id": account_id}))
            blocker, blocked = issue_pid, erase_pid
        try:
            async with asyncio.timeout(5):
                while blocker not in (
                    await db_session.scalar(
                        text("SELECT pg_blocking_pids(:pid)"), {"pid": blocked}
                    )
                ):
                    if waiting.done():
                        await waiting
                        pytest.fail(
                            "credential attachment and erasure did not serialize"
                        )
                    await asyncio.sleep(0.01)
            if first == "erasure":
                await eraser.commit()
                with pytest.raises(IntegrityError, match="erased account credentials"):
                    await waiting
                await issuer.rollback()
            else:
                await issuer.commit()
                await waiting
                with pytest.raises(IntegrityError, match="erased account credentials"):
                    await eraser.commit()
                await eraser.rollback()
        finally:
            if not waiting.done():
                waiting.cancel()
                await asyncio.gather(waiting, return_exceptions=True)
    assert await db_session.scalar(
        text("SELECT count(*) FROM account_session_tokens WHERE user_id=:id"),
        {"id": account_id},
    ) == (0 if first == "erasure" else 1)
    assert await db_session.scalar(
        text("SELECT erased_at IS NOT NULL FROM accounts WHERE id=:id"),
        {"id": account_id},
    ) == (first == "erasure")


async def test_login_skips_inactive_recorded_guest_without_rejecting_target(
    api_client, db_session
):
    from app.identity_lifecycle import deactivate_account
    from tests._helpers import make_user
    from tests.test_login import _issue_login_token

    guest = await make_user(db_session, "inactive-recorded-guest")
    target = await make_user(db_session, "active-login-target")
    target.email = "active-target@example.com"
    token = await _issue_login_token(db_session, target, "target-with-inactive-guest")
    token.guest_account_id = guest.id
    await db_session.commit()
    await deactivate_account(db_session, guest.id)
    await db_session.commit()
    response = await api_client.post(
        "/v1/login/consume", json={"token": "target-with-inactive-guest"}
    )
    assert response.status_code == 200, response.text
    assert response.json()["merged"] is None
    await db_session.refresh(guest)
    assert guest.merged_at is None
    assert guest.deactivated_at is not None


@pytest.mark.parametrize("first", ["deactivation", "binding"])
async def test_auth0_email_binding_serializes_with_deactivation(
    db_session, engine, first
):
    import asyncio

    from sqlalchemy.ext.asyncio import async_sessionmaker

    from app.auth0_provisioning import resolve_or_provision_user
    from app.identity_lifecycle import deactivate_account

    account = Account(email="binding-race@example.com")
    db_session.add(account)
    await db_session.commit()
    account_id = account.id
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with sessions() as binder, sessions() as deactivator:
        bind_pid = await binder.scalar(text("SELECT pg_backend_pid()"))
        deactivate_pid = await deactivator.scalar(text("SELECT pg_backend_pid()"))
        reached_gate, release_gate = asyncio.Event(), asyncio.Event()

        async def may_write():
            reached_gate.set()
            await release_gate.wait()
            return True

        async def bind():
            return await resolve_or_provision_user(
                binder,
                "auth0|binding-race",
                "binding-race@example.com",
                True,
                may_write=may_write,
            )

        if first == "deactivation":
            await deactivate_account(deactivator, account_id)
            waiting = asyncio.create_task(bind())
            blocker, blocked = deactivate_pid, bind_pid
        else:
            waiting = asyncio.create_task(bind())
            await asyncio.wait_for(reached_gate.wait(), 5)
            deactivating = asyncio.create_task(
                deactivate_account(deactivator, account_id)
            )
            blocker, blocked = bind_pid, deactivate_pid
        try:
            async with asyncio.timeout(5):
                while blocker not in (
                    await db_session.scalar(
                        text("SELECT pg_blocking_pids(:pid)"), {"pid": blocked}
                    )
                ):
                    if (first == "deactivation" and reached_gate.is_set()) or (
                        first == "binding" and deactivating.done()
                    ):
                        pytest.fail("Auth0 binding did not serialize with deactivation")
                    await asyncio.sleep(0.01)
            if first == "deactivation":
                await deactivator.commit()
                assert await waiting is None
            else:
                release_gate.set()
                resolved = await waiting
                assert resolved is not None and resolved.is_active
                await deactivating
                await deactivator.commit()
        finally:
            release_gate.set()
            tasks = [waiting] + ([deactivating] if first == "binding" else [])
            for task in tasks:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
    await db_session.refresh(account)
    assert not account.is_active
    assert account.auth0_sub == ("auth0|binding-race" if first == "binding" else None)


async def test_retirement_wins_before_director_registration(db_session, engine):
    import asyncio

    from sqlalchemy.ext.asyncio import async_sessionmaker

    from app.identity_lifecycle import retire_player
    from app.tournament_entries import enter_event
    from app.tournament_errors import PlayerNotFoundError
    from tests._helpers import make_user
    from tests.test_tournament_entries import _make_event

    owner = await make_user(db_session, "retirement-race-director")
    player = await make_user(db_session, "retirement-race-player")
    event = await _make_event(db_session, owner=owner)
    owner_id, player_id = owner.id, player.player_id
    event_id, tournament_id = event.id, event.tournament_id
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with sessions() as retiring, sessions() as entering:
        await retire_player(retiring, player_id)
        await retiring.flush()
        actor = await entering.get(Account, owner_id)
        entering_pid = await entering.scalar(text("SELECT pg_backend_pid()"))
        retiring_pid = await retiring.scalar(text("SELECT pg_backend_pid()"))
        attempt = asyncio.create_task(
            enter_event(
                entering,
                tournament_id=tournament_id,
                event_id=event_id,
                actor=actor,
                user_id=player_id,
            )
        )
        try:
            async with asyncio.timeout(5):
                while retiring_pid not in (
                    await db_session.scalar(
                        text("SELECT pg_blocking_pids(:pid)"), {"pid": entering_pid}
                    )
                ):
                    if attempt.done():
                        await attempt
                        pytest.fail("registration ignored concurrent Player retirement")
                    await asyncio.sleep(0.01)
            await retiring.commit()
            with pytest.raises(PlayerNotFoundError):
                await attempt
        finally:
            if not attempt.done():
                attempt.cancel()
                await asyncio.gather(attempt, return_exceptions=True)
    assert (
        await db_session.scalar(
            text("SELECT count(*) FROM tournament_entries WHERE event_id=:id"),
            {"id": event_id},
        )
        == 0
    )


async def test_new_entry_membership_rejects_retired_player_in_sql(db_session):
    from app.identity_lifecycle import retire_player
    from app.models import TournamentEntry
    from tests._helpers import make_user
    from tests.test_tournament_entries import _make_event

    player = await make_user(db_session, "sql-retired-member")
    event = await _make_event(db_session)
    await retire_player(db_session, player.player_id)
    await db_session.commit()
    entry = TournamentEntry(event_id=event.id)
    db_session.add(entry)
    await db_session.flush()
    with pytest.raises(IntegrityError, match="retired Player cannot be admitted"):
        async with db_session.begin_nested():
            await db_session.execute(
                text(
                    "INSERT INTO tournament_entry_members(entry_id,player_id) "
                    "VALUES(:entry,:player)"
                ),
                {"entry": entry.id, "player": player.player_id},
            )
            await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))


async def test_retired_player_can_withdraw_but_sql_cannot_reenter(
    api_client, db_session
):
    from app.identity_lifecycle import retire_player
    from tests._helpers import start_session
    from tests.test_tournament_entries import _entries_url, _make_event

    actor = await start_session(api_client, db_session)
    event = await _make_event(db_session)
    entered = await api_client.post(_entries_url(event))
    assert entered.status_code == 201, entered.text
    entry_id = entered.json()["id"]
    await retire_player(db_session, actor.player_id)
    await db_session.commit()
    withdrawn = await api_client.delete(f"{_entries_url(event)}/{entry_id}")
    assert withdrawn.status_code == 204, withdrawn.text
    detail = await api_client.get(f"/v1/tournaments/{event.tournament_id}")
    assert detail.status_code == 200, detail.text
    assert detail.json()["events"][0]["entry_state"] == {"state": "retired"}
    with pytest.raises(IntegrityError, match="retired Player cannot be admitted"):
        async with db_session.begin_nested():
            await db_session.execute(
                text("UPDATE tournament_entries SET status='entered' WHERE id=:id"),
                {"id": entry_id},
            )
            await db_session.execute(
                text(
                    "INSERT INTO tournament_entry_registrations"
                    "(entry_id,registered_by_account_id) VALUES(:entry,:actor)"
                ),
                {"entry": entry_id, "actor": actor.id},
            )
            await db_session.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))


@pytest.mark.parametrize("role", ["creator", "opponent"])
async def test_retirement_wins_before_new_standalone_match(db_session, engine, role):
    import asyncio

    from sqlalchemy.ext.asyncio import async_sessionmaker

    from app.identity_lifecycle import retire_player
    from app.match_creation import OpponentNotFoundError, create_match
    from app.player_accounts import PlayerAccessDenied

    creator, opponent = (
        Account(username="race-creator"),
        Account(username="race-opponent"),
    )
    db_session.add_all([creator, opponent])
    await db_session.commit()
    creator_id, opponent_id = creator.id, opponent.player_id
    retiring_id = creator.player_id if role == "creator" else opponent_id
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with sessions() as retiring, sessions() as creating:
        await retire_player(retiring, retiring_id)
        await retiring.flush()
        actor = await creating.get(Account, creator_id)
        create_pid = await creating.scalar(text("SELECT pg_backend_pid()"))
        retire_pid = await retiring.scalar(text("SELECT pg_backend_pid()"))
        attempt = asyncio.create_task(
            create_match(
                creating,
                creator=actor,
                opponent_user_id=opponent_id,
                league_id=None,
                best_of=3,
                rated=False,
            )
        )
        try:
            async with asyncio.timeout(5):
                while retire_pid not in (
                    await db_session.scalar(
                        text("SELECT pg_blocking_pids(:pid)"), {"pid": create_pid}
                    )
                ):
                    if attempt.done():
                        await attempt
                        pytest.fail("new match ignored Player retirement")
                    await asyncio.sleep(0.01)
            await retiring.commit()
            with pytest.raises(
                PlayerAccessDenied if role == "creator" else OpponentNotFoundError
            ):
                await attempt
        finally:
            if not attempt.done():
                attempt.cancel()
                await asyncio.gather(attempt, return_exceptions=True)
    assert await db_session.scalar(text("SELECT count(*) FROM matches")) == 0


@pytest.mark.parametrize(
    "purpose,inactive_role",
    [("change", "owner"), ("merge", "owner"), ("merge", "target")],
)
@pytest.mark.parametrize("deactivation", ["service", "sql"])
async def test_confirmation_cannot_authenticate_a_deactivated_account(
    api_client, db_session, purpose, inactive_role, deactivation
):
    from app.identity_lifecycle import deactivate_account, reactivate_account
    from app.models.user_token import EmailPurpose, EmailToken
    from app.sessions import hash_token

    owner, target = Account(), Account(email="confirmation-target@example.com")
    db_session.add_all([owner, target])
    await db_session.flush()
    db_session.add(
        EmailToken(
            user_id=owner.id,
            target_account_id=target.id if purpose == "merge" else None,
            purpose=EmailPurpose(purpose),
            sent_to=target.email if purpose == "merge" else "new-address@example.com",
            token=hash_token("inactive-confirmation"),
        )
    )
    await db_session.commit()
    inactive = owner if inactive_role == "owner" else target
    if deactivation == "service":
        await deactivate_account(db_session, inactive.id)
    else:
        await db_session.execute(
            text("UPDATE accounts SET deactivated_at=clock_timestamp() WHERE id=:id"),
            {"id": inactive.id},
        )
    await db_session.commit()
    response = await api_client.post(
        "/v1/me/email/confirm", json={"token": "inactive-confirmation"}
    )
    assert response.status_code == 400, response.text
    await reactivate_account(db_session, inactive.id)
    await db_session.commit()
    response = await api_client.post(
        "/v1/me/email/confirm", json={"token": "inactive-confirmation"}
    )
    assert response.status_code == 400, response.text
    await db_session.refresh(owner)
    assert owner.email is None and owner.merged_at is None


@pytest.mark.parametrize("purpose", ["change", "merge"])
async def test_confirmation_refreshes_activity_after_waiting_for_deactivation(
    api_client, db_session, engine, purpose
):
    import asyncio

    from sqlalchemy.ext.asyncio import async_sessionmaker

    from app.models.user_token import EmailPurpose, EmailToken
    from app.sessions import hash_token

    owner, target = Account(), Account(email="confirmation-race@example.com")
    db_session.add_all([owner, target])
    await db_session.flush()
    db_session.add(
        EmailToken(
            user_id=owner.id,
            target_account_id=target.id if purpose == "merge" else None,
            purpose=EmailPurpose(purpose),
            sent_to=target.email
            if purpose == "merge"
            else "confirmed-race@example.com",
            token=hash_token("confirmation-race"),
        )
    )
    await db_session.commit()
    inactive_id = owner.id if purpose == "change" else target.id
    request_pid = await db_session.scalar(text("SELECT pg_backend_pid()"))
    async with async_sessionmaker(engine)() as deactivator:
        deactivate_pid = await deactivator.scalar(text("SELECT pg_backend_pid()"))
        await deactivator.execute(
            text("UPDATE accounts SET deactivated_at=clock_timestamp() WHERE id=:id"),
            {"id": inactive_id},
        )
        attempt = asyncio.create_task(
            api_client.post("/v1/me/email/confirm", json={"token": "confirmation-race"})
        )
        try:
            async with asyncio.timeout(5):
                while deactivate_pid not in (
                    await deactivator.scalar(
                        text("SELECT pg_blocking_pids(:pid)"), {"pid": request_pid}
                    )
                ):
                    if attempt.done():
                        pytest.fail(
                            f"confirmation ignored deactivation: {await attempt}"
                        )
                    await asyncio.sleep(0.01)
            await deactivator.commit()
            response = await attempt
            assert response.status_code == 400, response.text
        finally:
            if not attempt.done():
                attempt.cancel()
                await asyncio.gather(attempt, return_exceptions=True)
    assert (
        await db_session.scalar(text("SELECT count(*) FROM account_session_tokens"))
        == 0
    )


@pytest.mark.parametrize("initially_retired", [False, True])
async def test_retirement_transition_cannot_release_username(
    db_session, initially_retired
):
    from app.identity_lifecycle import retire_player

    player = Player(username="transition-reserved")
    db_session.add(player)
    await db_session.commit()
    if initially_retired:
        await retire_player(db_session, player.id)
        await db_session.commit()
    with pytest.raises(IntegrityError, match="reserved"):
        async with db_session.begin_nested():
            await db_session.execute(
                text(
                    "UPDATE players SET username='released', retired_at="
                    + ("NULL" if initially_retired else "clock_timestamp()")
                    + " WHERE id=:id"
                ),
                {"id": player.id},
            )


async def test_set_email_refreshes_activity_after_deactivation(db_session, engine):
    from fastapi import HTTPException
    from sqlalchemy.ext.asyncio import async_sessionmaker

    from app.identity_lifecycle import deactivate_account, reactivate_account
    from app.sessions import SetEmailRequest, set_email
    from tests._helpers import make_user

    actor = await make_user(db_session, "stale-email-writer")
    await db_session.commit()
    async with async_sessionmaker(engine)() as other:
        await deactivate_account(other, actor.id)
        await other.commit()
    with pytest.raises(HTTPException) as error:
        await set_email(
            SetEmailRequest(email="late@example.com", captcha_token="test-token"),
            db_session,
            actor,
        )
    assert error.value.status_code == 401
    actor_id = actor.id
    await db_session.rollback()
    await reactivate_account(db_session, actor_id)
    await db_session.commit()
    assert (
        await db_session.scalar(text("SELECT count(*) FROM account_email_tokens")) == 0
    )
    assert (
        await db_session.scalar(text("SELECT count(*) FROM account_email_intents")) == 0
    )


@pytest.mark.parametrize("fresh_request", [False, True])
async def test_multihop_merge_keeps_held_entry_identifiable_and_withdrawable(
    api_client, db_session, fresh_request
):
    from app.account_merge import merge_user
    from app.tournament_queries import active_entrants_by_event
    from app.tournament_serialization import serialize_event
    from tests._helpers import make_user, start_session
    from tests.test_tournament_entries import _entries_url, _make_event

    target = await start_session(api_client, db_session)
    source = await make_user(db_session, "held-original")
    middle = await make_user(db_session, "held-middle")
    event = await _make_event(db_session)
    from app.tournament_entries import enter_event

    entered = await enter_event(
        db_session,
        tournament_id=event.tournament_id,
        event_id=event.id,
        actor=source,
        user_id=None,
    )
    await db_session.commit()
    original_player_id = source.player_id
    await merge_user(db_session, from_user_id=source.id, to_user_id=middle.id)
    await db_session.commit()
    await merge_user(db_session, from_user_id=middle.id, to_user_id=target.id)
    await db_session.commit()
    entrants = (await active_entrants_by_event(db_session, [event.id]))[event.id]
    serialized = serialize_event(
        event, entrants=entrants, fixtures=[], rating=None, game_counts=None
    )
    assert serialized.entered == 1
    assert serialized.entrants[0].user_id == target.player_id
    assert serialized.entrants[0].username == target.username
    assert serialized.retained_entrants == []
    assert (
        await db_session.scalar(
            text("SELECT player_id FROM tournament_entry_members WHERE entry_id=:id"),
            {"id": entered.id},
        )
        == original_player_id
    )
    withdrawal_url = f"{_entries_url(event)}/{entered.id}"
    if fresh_request:
        db_session.expunge_all()
    response = await api_client.delete(withdrawal_url)
    assert response.status_code == 204, response.text


async def test_set_email_cannot_queue_merge_into_inactive_target(
    api_client, db_session
):
    from app.identity_lifecycle import deactivate_account, reactivate_account
    from tests._helpers import make_user, start_session
    from tests.test_email import _set_email

    await start_session(api_client, db_session)
    target = await make_user(db_session, "inactive-merge-destination")
    target.email = "inactive-destination@example.com"
    await db_session.commit()
    await deactivate_account(db_session, target.id)
    await db_session.commit()
    response = await _set_email(api_client, email=target.email)
    assert response.status_code == 202, response.text
    await reactivate_account(db_session, target.id)
    await db_session.commit()
    assert (
        await db_session.scalar(text("SELECT count(*) FROM account_email_tokens")) == 0
    )
    assert (
        await db_session.scalar(text("SELECT count(*) FROM account_email_intents")) == 0
    )


@pytest.mark.parametrize("inactive_role", ["owner", "target"])
async def test_set_email_waits_for_deactivation_before_issuing_credential(
    db_session, engine, inactive_role
):
    import asyncio

    from fastapi import HTTPException
    from sqlalchemy.ext.asyncio import async_sessionmaker

    from app.identity_lifecycle import deactivate_account, reactivate_account
    from app.sessions import SetEmailRequest, set_email
    from tests._helpers import make_user

    actor = await make_user(db_session, "queued-email-owner")
    target = await make_user(db_session, "queued-email-target")
    target.email = "queued-target@example.com"
    await db_session.commit()
    inactive_id = actor.id if inactive_role == "owner" else target.id
    request_pid = await db_session.scalar(text("SELECT pg_backend_pid()"))
    async with async_sessionmaker(engine)() as deactivator:
        deactivate_pid = await deactivator.scalar(text("SELECT pg_backend_pid()"))
        await deactivate_account(deactivator, inactive_id)
        attempt = asyncio.create_task(
            set_email(
                SetEmailRequest(email=target.email, captcha_token="test-token"),
                db_session,
                actor,
            )
        )
        try:
            async with asyncio.timeout(5):
                while deactivate_pid not in (
                    await deactivator.scalar(
                        text("SELECT pg_blocking_pids(:pid)"), {"pid": request_pid}
                    )
                ):
                    if attempt.done():
                        pytest.fail(
                            "email writer did not wait for Account deactivation"
                        )
                    await asyncio.sleep(0.01)
            await deactivator.commit()
            if inactive_role == "owner":
                with pytest.raises(HTTPException) as error:
                    await attempt
                assert error.value.status_code == 401
            else:
                await attempt
        finally:
            if not attempt.done():
                attempt.cancel()
                await asyncio.gather(attempt, return_exceptions=True)
    await db_session.rollback()
    await reactivate_account(db_session, inactive_id)
    await db_session.commit()
    assert (
        await db_session.scalar(text("SELECT count(*) FROM account_email_tokens")) == 0
    )
    assert (
        await db_session.scalar(text("SELECT count(*) FROM account_email_intents")) == 0
    )

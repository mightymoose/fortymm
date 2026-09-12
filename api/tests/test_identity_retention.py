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
    from datetime import UTC, datetime

    from app.email_credentials import email_action_is_valid
    from app.models.user_token import EmailPurpose, EmailToken, SessionToken
    from app.sessions import get_optional_user, hash_token

    account = Account(email="offline@example.com", deactivated_at=datetime.now(UTC))
    db_session.add(account)
    await db_session.flush()
    db_session.add(SessionToken(user_id=account.id, token=hash_token("old-cookie")))
    await db_session.commit()
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

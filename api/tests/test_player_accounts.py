"""Account authority and sporting identity are independent database facts."""

from sqlalchemy import select

from app.models import Account, Player


async def test_account_and_unclaimed_player_can_exist_independently(db_session):
    account = Account(email="director@example.com")
    player = Player(username="unclaimed-player")
    db_session.add_all([account, player])
    await db_session.commit()
    db_session.expunge_all()

    saved_account = await db_session.scalar(select(Account))
    saved_player = await db_session.scalar(select(Player))
    assert saved_account.primary_player is None
    assert saved_player.username == "unclaimed-player"
    assert saved_account.id != saved_player.id


async def test_only_explicit_management_authorizes_a_player(db_session):
    import pytest

    from app.models import AccountPlayer
    from app.player_accounts import PlayerAccessDenied, require_player

    player = Player(username="managed-player")
    manager = Account(
        email="parent@example.com",
        player_grants=[AccountPlayer(player=player, is_primary=True)],
    )
    stranger = Account(email="stranger@example.com")
    db_session.add_all([manager, stranger])
    await db_session.commit()

    assert (await require_player(db_session, manager.id, player.id)).id == player.id
    with pytest.raises(PlayerAccessDenied):
        await require_player(db_session, stranger.id, player.id)


async def test_guest_session_creates_account_primary_player_and_grant(
    api_client, db_session
):
    response = await api_client.get("/v1/session")
    assert response.status_code == 200
    body = response.json()["data"]["user"]
    account = await db_session.scalar(select(Account))
    assert account is not None
    assert account.primary_player.username == body["username"]
    assert str(account.primary_player.id) == body["id"]
    assert len(account.player_grants) == 1


async def test_match_participation_uses_players_and_creation_uses_account(db_session):
    from app.match_creation import create_match
    from app.models import AccountPlayer

    player = Player(username="managed-competitor")
    opponent = Player(username="opponent-without-login")
    account = Account(
        email="manager@example.com",
        player_grants=[AccountPlayer(player=player, is_primary=True)],
    )
    db_session.add_all([account, opponent])
    await db_session.commit()

    match = await create_match(
        db_session,
        creator=account,
        opponent_user_id=opponent.id,
        league_id=None,
        best_of=3,
        rated=False,
    )
    assert {
        side_player.user_id for side in match.sides for side_player in side.players
    } == {player.id, opponent.id}
    assert match.created_by_user_id == account.id
    assert match.created_by_user_id != player.id


async def test_sporting_foreign_keys_reference_players(db_session):
    from sqlalchemy import text

    for table, column in (
        ("match_side_players", "user_id"),
        ("tournament_entry_members", "player_id"),
        ("match_lineup_players", "player_id"),
        ("league_memberships", "user_id"),
        ("user_league_ratings", "user_id"),
        ("rating_history", "user_id"),
    ):
        target = await db_session.scalar(
            text("""
            SELECT ccu.table_name FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              USING (constraint_catalog, constraint_schema, constraint_name)
            JOIN information_schema.constraint_column_usage ccu
              USING (constraint_catalog, constraint_schema, constraint_name)
            WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = :table
              AND kcu.column_name = :column
        """),
            {"table": table, "column": column},
        )
        assert target == "players", table


async def test_same_person_merge_preserves_actor_and_combines_primary_players(
    db_session,
):
    from app.account_merge import merge_user
    from app.match_creation import create_match
    from app.models import AccountPlayer, Match

    guest_player = Player(username="guest-competitor")
    target_player = Player(username="claimed-competitor")
    guest = Account(player_grants=[AccountPlayer(player=guest_player, is_primary=True)])
    target = Account(
        email="claimed@example.com",
        player_grants=[AccountPlayer(player=target_player, is_primary=True)],
    )
    db_session.add_all([guest, target])
    await db_session.commit()
    match = await create_match(
        db_session,
        creator=guest,
        opponent_user_id=None,
        league_id=None,
        best_of=3,
        rated=False,
    )
    match_id, guest_id, target_id = match.id, guest.id, target.id
    guest_player_id, target_player_id = guest_player.id, target_player.id

    await merge_user(db_session, from_user_id=guest_id, to_user_id=target_id)
    await db_session.commit()
    db_session.expunge_all()
    saved_match = await db_session.get(Match, match_id)
    assert saved_match.created_by_user_id == guest_id
    saved_guest = await db_session.get(Account, guest_id)
    assert saved_guest.merged_into_user_id == target_id
    assert saved_guest.player_grants == []
    retired_player = await db_session.get(Player, guest_player_id)
    assert retired_player.merged_into_player_id == target_player_id


async def test_account_transfer_keeps_player_id_and_tombstone_cannot_act(db_session):
    import pytest

    from app.account_merge import merge_user
    from app.models import AccountPlayer
    from app.player_accounts import PlayerAccessDenied, require_player

    source = Account(username="transfer-player")
    target = Account(email="new-owner@example.com")
    db_session.add_all([source, target])
    await db_session.commit()
    player_id, source_id, target_id = source.player_id, source.id, target.id
    await merge_user(db_session, from_user_id=source_id, to_user_id=target_id)
    await db_session.commit()
    db_session.expunge_all()
    saved_target = await db_session.get(Account, target_id)
    assert saved_target.player_id == player_id
    assert (await require_player(db_session, target_id, player_id)).id == player_id
    # Even a retained or accidentally reinserted grant must never revive an account.
    db_session.add(AccountPlayer(account_id=source_id, player_id=player_id))
    await db_session.commit()
    with pytest.raises(PlayerAccessDenied):
        await require_player(db_session, source_id, player_id)


async def test_tournament_owner_transfers_but_creator_does_not(db_session):
    from app.account_merge import merge_user
    from app.geocoding import FakeGeocoder
    from app.models import Tournament
    from app.schemas.tournament import TournamentCreate
    from app.tournament_lifecycle import create_tournament

    guest, target = (
        Account(username="guest-director"),
        Account(username="claimed-director"),
    )
    db_session.add_all([guest, target])
    await db_session.commit()
    tournament = await create_tournament(
        db_session,
        actor=guest,
        payload=TournamentCreate(name="Preserved creator"),
        geocoder=FakeGeocoder(),
    )
    tournament_id, guest_id, target_id = tournament.id, guest.id, target.id
    await merge_user(db_session, from_user_id=guest_id, to_user_id=target_id)
    await db_session.commit()
    db_session.expunge_all()
    saved = await db_session.get(Tournament, tournament_id)
    assert saved.created_by_user_id == guest_id
    assert saved.owner_account_id == target_id


async def test_login_identity_is_namespaced_and_belongs_to_account(db_session):
    from app.auth0_provisioning import resolve_or_provision_user
    from app.models import LoginIdentity

    account = await resolve_or_provision_user(
        db_session, "auth0|competitor", "identity@example.com", True
    )
    assert account is not None
    identity = await db_session.scalar(
        select(LoginIdentity).where(LoginIdentity.subject == "auth0|competitor")
    )
    assert identity.account_id == account.id
    assert identity.provider == "auth0"
    assert identity.issuer
    assert account.primary_player is not None


async def test_unclaimed_player_has_public_sporting_profile(api_client, db_session):
    await api_client.get("/v1/session")
    player = Player(username="no-login-needed")
    db_session.add(player)
    await db_session.commit()
    response = await api_client.get(f"/v1/players/{player.id}")
    assert response.status_code == 200
    assert "no-login-needed" in response.text


async def test_managers_can_propose_and_accept_for_their_primary_players(
    db_session, monkeypatch
):
    from app.match_creation import create_match
    from app.models import AccountPlayer, MatchStatus
    from app.result_acceptance import accept_result
    from app.result_proposal import propose_result
    from app.schemas.match import MatchResultsGameWrite

    first = Account(
        player_grants=[
            AccountPlayer(player=Player(username="first-managed"), is_primary=True)
        ]
    )
    second = Account(
        player_grants=[
            AccountPlayer(player=Player(username="second-managed"), is_primary=True)
        ]
    )
    db_session.add_all([first, second])
    await db_session.commit()
    match = await create_match(
        db_session,
        creator=first,
        opponent_user_id=second.player_id,
        league_id=None,
        best_of=1,
        rated=True,
    )
    proposed = await propose_result(
        db_session,
        match.id,
        first.id,
        games=[MatchResultsGameWrite(game_number=1, side_1_points=11, side_2_points=4)],
        supersedes_result_id=None,
    )
    assert proposed.awaiting_acceptance
    from app.match_result_notifications import notify_result_posted
    from tests.test_retirement_jobs import _notifications

    notifications = _notifications(db_session)
    queued = []
    monkeypatch.setattr(
        notifications, "enqueue_notification", lambda job: queued.append(job) or True
    )
    await notify_result_posted(notifications, proposed.match, first.player_id)
    assert [job.user_id for job in queued] == [second.id]
    result = proposed.match.results[0]
    assert result.submitted_by_user_id == first.id
    completed = await accept_result(
        db_session, match.id, second.id, result_id=result.id
    )
    assert completed.status is MatchStatus.completed
    assert completed.results[0].accepted_by_user_id == second.id


async def test_tournament_entry_is_for_managed_player_not_account(db_session):
    from app.models import AccountPlayer, Tournament, TournamentEntry, TournamentStatus
    from app.tournament_entries import enter_event
    from tests.test_account_merge import _make_event

    director = Account(username="entry-director")
    manager = Account(
        player_grants=[
            AccountPlayer(player=Player(username="entry-player"), is_primary=True)
        ]
    )
    db_session.add_all([director, manager])
    await db_session.commit()
    event = await _make_event(db_session, director)
    tournament = await db_session.get(Tournament, event.tournament_id)
    tournament.status = TournamentStatus.published
    await db_session.commit()
    entrant = await enter_event(
        db_session,
        tournament_id=tournament.id,
        event_id=event.id,
        actor=manager,
        user_id=None,
    )
    entry = await db_session.get(TournamentEntry, entrant.id)
    assert entry.user_id == manager.player_id
    assert entry.user_id != manager.id


async def test_existing_session_and_match_views_follow_primary_player(
    api_client, db_session
):
    from app.match_creation import create_match
    from app.models import AccountPlayer

    await api_client.get("/v1/session")
    account = await db_session.scalar(select(Account))
    account.player_grants.clear()
    await db_session.flush()
    account.player_grants.append(
        AccountPlayer(player=Player(username="new-primary"), is_primary=True)
    )
    await db_session.commit()
    response = await api_client.get("/v1/session")
    assert response.json()["data"]["user"]["id"] == str(account.player_id)
    match = await create_match(
        db_session,
        creator=account,
        opponent_user_id=None,
        league_id=None,
        best_of=1,
        rated=False,
    )
    response = await api_client.get(f"/v1/matches/{match.id}")
    assert response.status_code == 200
    assert response.json()["can_score"] is True
    attention = await api_client.get("/v1/matches?attention=true")
    assert [row["id"] for row in attention.json()["items"]] == [str(match.id)]


async def test_database_refuses_partial_account_tombstone(db_session):
    import pytest
    from sqlalchemy import text
    from sqlalchemy.exc import IntegrityError

    account = Account(email="partial-tombstone@example.com")
    db_session.add(account)
    await db_session.commit()
    with pytest.raises(IntegrityError):
        async with db_session.begin_nested():
            await db_session.execute(
                text("UPDATE accounts SET merged_at = now() WHERE id = :id"),
                {"id": account.id},
            )


async def test_database_refuses_partial_player_tombstone(db_session):
    import pytest
    from sqlalchemy import text
    from sqlalchemy.exc import IntegrityError

    player = Player(username="partial-player-tombstone")
    db_session.add(player)
    await db_session.commit()
    with pytest.raises(IntegrityError):
        async with db_session.begin_nested():
            await db_session.execute(
                text("UPDATE players SET merged_at = now() WHERE id = :id"),
                {"id": player.id},
            )


async def test_losing_primary_grant_never_selects_another_managed_player(db_session):
    from app.models import AccountPlayer
    from app.player_accounts import primary_player_id

    primary = Player(username="former-primary")
    secondary = Player(username="managed-secondary")
    account = Account(
        player_grants=[
            AccountPlayer(player=primary, is_primary=True),
            AccountPlayer(player=secondary),
        ]
    )
    db_session.add(account)
    await db_session.commit()
    account_id = account.id
    await db_session.delete(account.player_grants[0])
    await db_session.commit()
    db_session.expunge_all()
    assert await primary_player_id(db_session, account_id) is None
    saved = await db_session.get(Account, account_id)
    assert saved.primary_player is None
    assert len(saved.player_grants) == 1


async def test_database_rejects_duplicate_grants_and_two_primary_players(db_session):
    import pytest
    from sqlalchemy import text
    from sqlalchemy.exc import IntegrityError

    from app.models import AccountPlayer

    first, second = Player(username="grant-first"), Player(username="grant-second")
    account = Account(player_grants=[AccountPlayer(player=first, is_primary=True)])
    db_session.add_all([account, second])
    await db_session.commit()
    for player_id in (first.id, second.id):
        with pytest.raises(IntegrityError):
            async with db_session.begin_nested():
                await db_session.execute(
                    text(
                        "INSERT INTO account_players "
                        "(account_id, player_id, is_primary) "
                        "VALUES (:account, :player, true)"
                    ),
                    {"account": account.id, "player": player_id},
                )


async def test_login_subject_uniqueness_is_scoped_to_issuer_and_provider(db_session):
    import pytest
    from sqlalchemy.exc import IntegrityError

    from app.models import LoginIdentity

    first, second = Account(), Account()
    db_session.add_all([first, second])
    await db_session.flush()
    db_session.add_all(
        [
            LoginIdentity(
                account_id=first.id,
                issuer="issuer-a",
                provider="oidc",
                subject="same-subject",
            ),
            LoginIdentity(
                account_id=second.id,
                issuer="issuer-b",
                provider="oidc",
                subject="same-subject",
            ),
        ]
    )
    await db_session.commit()
    with pytest.raises(IntegrityError):
        async with db_session.begin_nested():
            db_session.add(
                LoginIdentity(
                    account_id=second.id,
                    issuer="issuer-a",
                    provider="oidc",
                    subject="same-subject",
                )
            )
            await db_session.flush()


async def test_account_without_primary_player_cannot_create_a_match(db_session):
    import pytest

    from app.match_creation import create_match
    from app.player_accounts import PlayerAccessDenied

    account = Account()
    db_session.add(account)
    await db_session.commit()
    with pytest.raises(PlayerAccessDenied):
        await create_match(
            db_session,
            creator=account,
            opponent_user_id=None,
            league_id=None,
            best_of=1,
            rated=False,
        )


async def test_retirement_resolves_owing_player_to_its_current_account(
    db_session, default_league
):
    from datetime import timedelta

    from app.account_merge import merge_user
    from app.retirement_jobs import RetirementOutcome, retire_if_lapsed
    from tests.test_retirement_jobs import _build_standing_match, _notifications

    match, result, poster, opponent = await _build_standing_match(
        db_session, default_league, submitted_ago=timedelta(days=8)
    )
    poster_target = Account(username="retired-poster-target")
    opponent_target = Account()
    db_session.add_all([poster_target, opponent_target])
    await db_session.commit()
    await merge_user(db_session, from_user_id=poster.id, to_user_id=poster_target.id)
    await merge_user(
        db_session, from_user_id=opponent.id, to_user_id=opponent_target.id
    )
    await db_session.commit()
    match_id, result_id = match.id, result.id
    poster_id, opponent_account_id = poster.id, opponent_target.id
    db_session.expunge_all()
    outcome = await retire_if_lapsed(
        db_session, match_id, result_id, _notifications(db_session)
    )
    assert outcome is RetirementOutcome.retired
    from app.models import MatchResult

    saved_result = await db_session.get(MatchResult, result_id)
    assert saved_result.submitted_by_user_id == poster_id
    assert saved_result.accepted_by_user_id == opponent_account_id


async def test_actor_foreign_keys_restrict_deletion_of_history(db_session):
    from sqlalchemy import text

    for table, column in (
        ("matches", "created_by_user_id"),
        ("match_results", "submitted_by_user_id"),
        ("match_results", "accepted_by_user_id"),
        ("rating_history", "created_by_user_id"),
        ("tournaments", "created_by_user_id"),
        ("tournament_entries", "added_by_user_id"),
    ):
        row = (
            await db_session.execute(
                text("""
            SELECT target.relname, constraint_row.confdeltype
            FROM pg_constraint constraint_row
            JOIN pg_class origin ON origin.oid = constraint_row.conrelid
            JOIN pg_class target ON target.oid = constraint_row.confrelid
            JOIN pg_attribute attribute ON attribute.attrelid = origin.oid
              AND attribute.attnum = ANY(constraint_row.conkey)
            WHERE constraint_row.contype = 'f' AND origin.relname = :table
              AND attribute.attname = :column
        """),
                {"table": table, "column": column},
            )
        ).one()
        assert tuple(row) == ("accounts", b"r"), (table, column, row)


async def test_account_without_player_can_manage_owned_tournament_entries(db_session):
    from app.models import Tournament, TournamentStatus
    from app.tournament_entries import enter_event, withdraw_from_event
    from tests.test_account_merge import _make_event

    director = Account(email="nonplaying-director@example.com")
    player = Player(username="director-entered-unclaimed")
    db_session.add_all([director, player])
    await db_session.commit()
    event = await _make_event(db_session, director)
    tournament = await db_session.get(Tournament, event.tournament_id)
    tournament.status = TournamentStatus.published
    await db_session.commit()
    entrant = await enter_event(
        db_session,
        tournament_id=tournament.id,
        event_id=event.id,
        actor=director,
        user_id=player.id,
    )
    assert entrant.user_id == player.id
    await withdraw_from_event(
        db_session,
        tournament_id=tournament.id,
        event_id=event.id,
        entry_id=entrant.id,
        actor=director,
    )


async def test_account_without_primary_player_can_read_existing_pages(
    api_client, db_session
):
    from app.match_creation import create_match

    await api_client.get("/v1/session")
    account = await db_session.scalar(select(Account))
    account.player_grants.clear()
    other = Account(username="spectator-page-opponent")
    db_session.add(other)
    await db_session.commit()
    await create_match(
        db_session,
        creator=other,
        opponent_user_id=None,
        league_id=None,
        best_of=3,
        rated=False,
    )

    dashboard = await api_client.get("/v1/dashboard")
    assert dashboard.status_code == 200
    assert dashboard.json()["attention"] == []
    assert dashboard.json()["rating"]["state"] == "NOT_RATED_LEAGUE"
    for url in (
        "/v1/players/search?q=opponent",
        "/v1/players/recent",
        "/v1/matches.csv",
    ):
        assert (await api_client.get(url)).status_code == 200
    matches = await api_client.get("/v1/matches")
    assert matches.status_code == 200
    assert matches.json()["total"] == 1
    assert matches.json()["attention_count"] == 0
    assert matches.json()["items"][0]["can_score"] is False
    profile = await api_client.get(f"/v1/players/{other.player_id}")
    assert profile.status_code == 200
    assert profile.json()["head_to_head"]["versus_viewer"] is None
    attention = await api_client.get("/v1/matches?attention=true")
    assert attention.status_code == 200
    assert attention.json()["items"] == []


async def test_account_keeps_actor_name_after_player_transfer(db_session):
    from app.account_merge import merge_user

    source = Account(username="original-director")
    target = Account(email="actor-destination@example.com")
    db_session.add_all([source, target])
    await db_session.commit()
    await merge_user(db_session, from_user_id=source.id, to_user_id=target.id)
    await db_session.commit()
    assert source.username == "original-director"
    assert (
        await db_session.scalar(select(Account.username).where(Account.id == source.id))
        == "original-director"
    )
    assert Account(email="nonplaying@example.com").username == "Account"


async def test_transfer_promotes_existing_destination_management_grant(db_session):
    from app.account_merge import merge_user
    from app.models import AccountPlayer

    source = Account(username="already-managed-player")
    target = Account(player_grants=[AccountPlayer(player=source.primary_player)])
    db_session.add_all([source, target])
    await db_session.commit()
    player_id = source.player_id
    await merge_user(db_session, from_user_id=source.id, to_user_id=target.id)
    await db_session.commit()
    assert target.player_id == player_id
    assert len(target.player_grants) == 1
    assert source.primary_player is None


async def test_playerless_director_receives_structured_negotiation_conflicts(
    api_client, db_session
):
    from app.match_creation import create_match
    from app.result_proposal import propose_result
    from app.schemas.match import MatchResultsGameWrite
    from tests._helpers import attach_match_to_director_tournament

    await api_client.get("/v1/session")
    director = await db_session.scalar(select(Account))
    director.player_grants.clear()
    first, second = (
        Account(username="conflict-first"),
        Account(username="conflict-second"),
    )
    db_session.add_all([first, second])
    await db_session.commit()
    match = await create_match(
        db_session,
        creator=first,
        opponent_user_id=second.player_id,
        league_id=None,
        best_of=1,
        rated=True,
    )
    await attach_match_to_director_tournament(
        db_session,
        match.id,
        tag="playerless-conflict",
        director=director,
        p1=first,
        p2=second,
        best_of=1,
    )
    board = [MatchResultsGameWrite(game_number=1, side_1_points=11, side_2_points=4)]
    proposal = await propose_result(
        db_session, match.id, first.id, games=board, supersedes_result_id=None
    )
    old_result = proposal.match.results[0].id
    await propose_result(
        db_session, match.id, second.id, games=board, supersedes_result_id=old_result
    )
    response = await api_client.post(
        f"/v1/matches/{match.id}/results",
        json={"games": [game.model_dump() for game in board]},
    )
    assert response.status_code == 409
    assert response.json()["detail"]["viewer_state"] == "review"
    response = await api_client.post(
        f"/v1/matches/{match.id}/results/{old_result}/acceptance"
    )
    assert response.status_code == 409
    assert response.json()["detail"]["viewer_state"] == "review"


async def test_playerless_self_entry_is_a_client_refusal(api_client, db_session):
    from app.models import Tournament, TournamentStatus
    from tests.test_account_merge import _make_event

    await api_client.get("/v1/session")
    account = await db_session.scalar(select(Account))
    event = await _make_event(db_session, account)
    tournament = await db_session.get(Tournament, event.tournament_id)
    tournament.status = TournamentStatus.published
    account.player_grants.clear()
    await db_session.commit()
    response = await api_client.post(
        f"/v1/tournaments/{tournament.id}/events/{event.id}/entries"
    )
    assert response.status_code == 403
    assert "primary player" in response.json()["detail"].lower()


async def test_playerless_username_edit_is_explicit_refusal(api_client, db_session):
    await api_client.get("/v1/session")
    account = await db_session.scalar(select(Account))
    account.player_grants.clear()
    await db_session.commit()
    response = await api_client.patch("/v1/me", json={"username": "new-player-name"})
    assert response.status_code == 403
    assert "primary player" in response.json()["detail"].lower()

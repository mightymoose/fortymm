"""The default-user tournament access contract (#1092).

Viewing a published tournament and entering one of its events is open to every
signed-in user — including a guest — with NO permission grant. The
``tournament.view`` and ``tournament.enter`` permissions were deleted outright
rather than granted to the default ``User`` role, so these tests drive the routes
as an actor holding nothing at all (every user holds the default role, which
carries zero permissions, ADR-0016). Creating a tournament keeps its
``tournament.create`` gate; self-entry is bounded by a per-IP rate limit asked
inside the entry verb's self arm (ADR-0784), not by a router dependency.
"""

import uuid
from decimal import Decimal

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.models import (
    DrawType,
    EventFormat,
    League,
    Tournament,
    TournamentEvent,
    TournamentEventDrawSettings,
    TournamentStatus,
    User,
)
from app.tournament_entries import enter_event as enter_event_verb
from tests._helpers import grant_permissions, make_user, start_session


async def _make_published_tournament_with_singles_event(
    db_session: AsyncSession,
    league: League,
    owner: User,
    *,
    status: TournamentStatus = TournamentStatus.published,
) -> tuple:
    """A tournament in ``status`` (default ``published``) with one uncapped singles
    event carrying no rating predicate, written straight to the database — the
    create route is permission-gated, and this file's subject is the *absence* of
    a gate on reads and self-entry."""
    tournament = Tournament(
        name="Spring Open",
        status=status,
        address={
            "venue": "Berkeley TT Club",
            "street": "1 Shattuck Ave",
            "city": "Berkeley",
            "region": "CA",
            "postal": "94704",
            "country": "USA",
            "latitude": 37.8703,
            "longitude": -122.2731,
        },
        league_id=league.id,
        created_by_user_id=owner.id,
    )
    db_session.add(tournament)
    await db_session.flush()
    event = TournamentEvent(
        tournament_id=tournament.id,
        name="Open Singles",
        format=EventFormat.singles,
        draw_settings=TournamentEventDrawSettings.for_draw_type(DrawType.single_elim),
        max_players=None,
        entry_fee=Decimal("20.00"),
        timezone="America/Chicago",
        slot={"date": "2026-08-01", "start": "09:00", "end": "17:00"},
        match_settings={"rated": True, "length_games": 5},
        predicates=[],
    )
    db_session.add(event)
    await db_session.commit()
    await db_session.refresh(event)
    return tournament, event


@pytest.fixture
async def director(db_session: AsyncSession) -> User:
    """The tournament's owner, holding ONLY the ``tournament.create`` grant (they
    need it for nothing in this file — the tournaments here are seeded directly —
    but it keeps the actor story straight: nobody here is an admin)."""
    owner = await make_user(db_session, f"director-{uuid.uuid4().hex[:8]}")
    await grant_permissions(db_session, owner, ["tournament.create"])
    return owner


async def test_a_user_only_actor_can_list_read_and_enter(
    api_client: AsyncClient,
    db_session: AsyncSession,
    director: User,
    default_league,
) -> None:
    """A guest holding only the default ``User`` role (zero permissions) lists
    tournaments, reads a published one, and enters its singles event."""
    tournament, event = await _make_published_tournament_with_singles_event(
        db_session, default_league, director
    )

    guest = await start_session(api_client, db_session)
    assert guest.username  # a minted guest, no grants of any kind

    listed = await api_client.get("/v1/tournaments")
    assert listed.status_code == 200
    assert any(t["id"] == str(tournament.id) for t in listed.json())

    detail = await api_client.get(f"/v1/tournaments/{tournament.id}")
    assert detail.status_code == 200

    entered = await api_client.post(
        f"/v1/tournaments/{tournament.id}/events/{event.id}/entries"
    )
    assert entered.status_code == 201
    assert entered.json()["user_id"] == str(guest.id)

    withdrawn = await api_client.delete(
        f"/v1/tournaments/{tournament.id}/events/{event.id}/entries/"
        f"{entered.json()['id']}"
    )
    assert withdrawn.status_code == 204


async def test_a_user_only_actor_still_gets_403_on_create_and_geocode(
    api_client: AsyncClient,
    db_session: AsyncSession,
    director: User,
    default_league,
) -> None:
    """Creating a tournament keeps its ``tournament.create`` gate, and so does the
    geocode preview (``GET /v1/geocode``) that rides on it."""
    await start_session(api_client, db_session)

    created = await api_client.post(
        "/v1/tournaments",
        json={
            "name": "Nope Open",
            "address": {
                "venue": "Berkeley TT Club",
                "street": "1 Shattuck Ave",
                "city": "Berkeley",
                "region": "CA",
                "postal": "94704",
                "country": "USA",
            },
        },
    )
    assert created.status_code == 403

    geocoded = await api_client.get("/v1/geocode", params={"address": "1 Broadway"})
    assert geocoded.status_code == 403


async def test_a_user_only_actor_gets_404_not_403_on_a_draft_they_do_not_own(
    api_client: AsyncClient,
    db_session: AsyncSession,
    director: User,
    default_league,
) -> None:
    """A draft the caller cannot see answers 404, never 403 — a 403 would confirm
    the tournament exists."""
    tournament, _ = await _make_published_tournament_with_singles_event(
        db_session, default_league, director, status=TournamentStatus.draft
    )
    await start_session(api_client, db_session)

    detail = await api_client.get(f"/v1/tournaments/{tournament.id}")
    assert detail.status_code == 404


async def test_the_31st_self_entry_from_one_ip_inside_an_hour_gets_429(
    api_client: AsyncClient,
    db_session: AsyncSession,
    director: User,
    default_league,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The self-entry path is rate limited per client IP: past the ceiling the
    answer is a 429 whose message tells the player to retry shortly.

    The ceiling is read from the environment at ask-time, so the test lowers it
    rather than issuing 31 entries."""
    tournament, event = await _make_published_tournament_with_singles_event(
        db_session, default_league, director
    )
    guest = await start_session(api_client, db_session)

    monkeypatch.setenv("TOURNAMENT_ENTRY_IP_PER_HOUR", "3")

    url = f"/v1/tournaments/{tournament.id}/events/{event.id}/entries"
    for _ in range(3):
        response = await api_client.post(url)
        assert response.status_code == 201, response.text

        # A withdraw frees nothing about the IP budget — the limit is per IP, not
        # per entry — so withdraw and re-enter to keep the event enterable.
        entry_id = response.json()["id"]
        await api_client.delete(f"{url}/{entry_id}")

    limited = await api_client.post(url)
    assert limited.status_code == 429
    assert "retry" in limited.json()["detail"].lower()
    assert guest.username


async def test_the_director_entry_path_carries_no_rate_limit(
    api_client: AsyncClient,
    db_session: AsyncSession,
    default_league,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A request whose body names ANOTHER player is a director entry: ownership-
    gated, and unlimited — a director adding a field is not the guest-minting
    attack the per-IP ceiling bounds."""
    director = await start_session(api_client, db_session)
    tournament, event = await _make_published_tournament_with_singles_event(
        db_session, default_league, director
    )
    player_a = await make_user(db_session, f"player-a-{uuid.uuid4().hex[:8]}")
    player_b = await make_user(db_session, f"player-b-{uuid.uuid4().hex[:8]}")

    monkeypatch.setenv("TOURNAMENT_ENTRY_IP_PER_HOUR", "1")

    # The director signs in, self-enters ONCE (consuming the IP's whole budget),
    # then adds two players by name — both must succeed.
    self_entry = await api_client.post(
        f"/v1/tournaments/{tournament.id}/events/{event.id}/entries"
    )
    assert self_entry.status_code == 201

    for player in (player_a, player_b):
        response = await api_client.post(
            f"/v1/tournaments/{tournament.id}/events/{event.id}/entries",
            json={"user_id": str(player.id)},
        )
        assert response.status_code == 201, response.text


async def test_the_ceiling_reads_from_the_environment_with_a_30_per_hour_default() -> (
    None
):
    """The ceiling is not hardcoded: ``Settings`` reads
    ``TOURNAMENT_ENTRY_IP_PER_HOUR`` and defaults to 30 per hour."""
    assert Settings().tournament_entry_ip_per_hour == 30
    assert (
        Settings(tournament_entry_ip_per_hour=1000000).tournament_entry_ip_per_hour
        == 1000000
    )


async def test_the_verb_itself_carries_the_limit_not_the_router(
    db_session: AsyncSession,
    director: User,
    default_league,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The limit lives INSIDE the entry verb's self arm (ADR-0784): calling the
    verb directly with an exhausted IP key raises the domain error, with no
    FastAPI request anywhere in sight."""
    from app.tournament_errors import EntryRateLimitedError

    tournament, event = await _make_published_tournament_with_singles_event(
        db_session, default_league, director
    )
    guest = await make_user(db_session, f"guest-{uuid.uuid4().hex[:8]}")

    monkeypatch.setenv("TOURNAMENT_ENTRY_IP_PER_HOUR", "1")
    await enter_event_verb(
        db_session,
        tournament_id=tournament.id,
        event_id=event.id,
        actor=guest,
        user_id=None,
        client_ip="203.0.113.9",
    )
    with pytest.raises(EntryRateLimitedError):
        await enter_event_verb(
            db_session,
            tournament_id=tournament.id,
            event_id=event.id,
            actor=guest,
            user_id=None,
            client_ip="203.0.113.9",
        )
    # A different IP is a different budget — and a different player, since this
    # guest already holds an entry in the event.
    other_guest = await make_user(db_session, f"guest2-{uuid.uuid4().hex[:8]}")
    await enter_event_verb(
        db_session,
        tournament_id=tournament.id,
        event_id=event.id,
        actor=other_guest,
        user_id=None,
        client_ip="203.0.113.10",
    )

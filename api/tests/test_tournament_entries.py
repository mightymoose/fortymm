"""Persistence and route tests for ``tournament_entries``.

The load-bearing claim here is the **partial** unique index on
``(event_id, user_id) WHERE status = 'entered'``. Withdrawal is a soft-delete —
the row survives with ``status = 'withdrawn'`` — so a *plain* unique index would
leave the withdrawn row squatting on the pair and permanently lock the player out
of re-entering. ``test_withdrawn_player_may_enter_the_same_event_again`` (schema)
and ``test_enter_withdraw_then_enter_again_all_succeed_through_the_routes`` (the
whole journey over HTTP: enter → withdraw → enter again) are the tests that tell
the two apart: they pass only if the index is partial — and the route one
additionally fails if the duplicate check is a pre-flight ``SELECT`` instead of a
caught ``IntegrityError``, or if withdrawal deletes the row instead of flipping
its status.

The persistence tests exercise the schema the **models** declare (the suite builds
via ``Base.metadata.create_all``); that the **migration** declares the same schema
is covered by running ``alembic upgrade head`` against a fresh database.

The route tests drive the *real* permission gate — each client establishes a
genuine session via ``GET /v1/session`` and is granted ``tournament.enter``
through real RBAC rows — so "who may enter" is proven, not stubbed. Mutating
requests carry the double-submit CSRF token via the client fixtures' event hooks.
"""

import asyncio
import uuid
from collections.abc import AsyncIterator, Callable
from decimal import Decimal
from typing import Any

import pytest
import pytest_asyncio
from fastapi import HTTPException
from httpx import AsyncClient
from sqlalchemy import delete, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from app.leagues import get_default_league
from app.models import (
    DrawType,
    EventFormat,
    League,
    LeagueVisibility,
    Tournament,
    TournamentEntry,
    TournamentEntryStatus,
    TournamentEvent,
    TournamentEventDrawSettings,
    TournamentStatus,
    User,
    UserLeagueRating,
)
from app.tournament_entries import enter_event as enter_event_verb
from app.tournament_entries import withdraw_from_event as withdraw_from_event_verb
from app.tournament_errors import (
    EntryNotFoundError,
    EntryRefusal,
    EntryRefusedError,
    EventNotFoundError,
    NonSinglesEntryError,
    NotAllowedToEnterError,
    NotAllowedToWithdrawError,
    NotTournamentOwnerError,
    PlayerNotFoundError,
    TournamentNotFoundError,
    WithdrawalRegistrationClosedError,
)
from app.tournaments import (
    TOURNAMENT_ENTER,
    TOURNAMENT_VIEW,
    enter_event,
    withdraw_from_event,
)
from tests._helpers import (
    counted_statements,
    grant_permissions,
    make_client,
    make_user,
    rate_player,
    start_session,
)

ACTIVE_ENTRY_INDEX = "uq_tournament_entries_event_id_user_id_active"


async def _make_event(
    db_session: AsyncSession,
    format: EventFormat = EventFormat.singles,
    status: TournamentStatus = TournamentStatus.published,
    max_players: int | None = 64,
    predicates: list[dict[str, Any]] | None = None,
    league: League | None = None,
    owner: User | None = None,
) -> TournamentEvent:
    """An event of ``format`` under a tournament in ``status``, owned by its own
    throwaway director. Written straight to the database rather than through the
    create routes: those are owner-only and permission-gated, and dragging that
    setup in would blur which grant the entry route is actually being tested
    against.

    ``owner`` defaults to a throwaway director *nobody in the test is signed in as* —
    which is what keeps the self-registration tests honest: the entrant is never
    accidentally the owner, so none of them can be passing through the director's arm
    of the fork (ADR-0784). The director tests pass the owner they mean.

    ``status`` defaults to ``published`` because that is the one status in which
    registration is open (ADR-0017): every test here that enters or withdraws needs
    an open window, and a tournament that could not be entered would say nothing
    about the entry rules. The column is **written directly** — the starting status
    is never reached by walking ``POST /transitions``, because a bug in the
    transitions guard must not be able to build this file's preconditions and so
    hide itself.

    The JSONB value-objects carry *valid* payloads rather than partial dicts — the
    read path validates them into ``Address``/``Slot``/``MatchSettings`` on the way
    out, so a partial one would 500 any test that reads this tournament back
    through ``GET /v1/tournaments/{id}`` (as the withdrawal-count test does).

    ``max_players`` defaults to a field nobody in this file is going to fill, so the
    capacity guard (ADR-0783) stays out of the way of every test that is about
    something else; the capacity tests pass the small number they mean. ``None`` is a
    legal value and does not mean "unset": it is the **uncapped** event of ADR-0935,
    which the capacity tests below use to prove the guard steps aside entirely.

    ``predicates`` defaults to **no rules at all**, for the same reason: an event with
    no eligibility rules admits everybody, so the rating guard (ADR-0783) stays out of
    the way of every test that is about something else. The eligibility tests pass the
    rule they mean, and ``league`` lets them say which ladder it is judged on.
    """
    if owner is None:
        owner = await make_user(db_session, f"director-{uuid.uuid4().hex[:8]}")
    # Every tournament names the ladder its eligibility is judged on (ADR-0783);
    # the column is NOT NULL. Most tests here don't turn on *which* league, so it is
    # the default one the autouse fixture seeds — the eligibility tests that do care
    # pass their own.
    if league is None:
        league = await get_default_league(db_session)
    assert league is not None, "the autouse default_league fixture seeds this"
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
        format=format,
        draw_settings=TournamentEventDrawSettings.for_draw_type(DrawType.single_elim),
        max_players=max_players,
        entry_fee=Decimal("20.00"),
        timezone="America/Chicago",
        slot={"date": "2026-08-01", "start": "09:00", "end": "17:00"},
        match_settings={"rated": True, "length_games": 5},
        predicates=predicates if predicates is not None else [],
    )
    db_session.add(event)
    await db_session.commit()
    await db_session.refresh(event)
    return event


@pytest_asyncio.fixture
async def event(db_session: AsyncSession) -> TournamentEvent:
    """A singles event under a tournament owned by its own throwaway director."""
    return await _make_event(db_session)


@pytest_asyncio.fixture
async def doubles_event(db_session: AsyncSession) -> TournamentEvent:
    return await _make_event(db_session, format=EventFormat.doubles)


@pytest_asyncio.fixture
async def player(db_session: AsyncSession) -> User:
    """A player who may enter — a real ``tournament.enter`` grant, through real RBAC
    rows.

    Most tests use them only as a *seeded* entrant, for whom the grant is irrelevant.
    It is here for the ones that drive ``enter_event`` / ``withdraw_from_event`` as
    functions (the lock races below): the self-registration arm of the fork asks for
    that permission *inside* the handler (ADR-0784 — it cannot be a router dependency,
    because the dependency runs before the body that says which arm this is), so a
    player without it is refused before the lock is ever taken, and the race the test
    means to stage never happens.
    """
    user = await make_user(db_session, f"player-{uuid.uuid4().hex[:8]}")
    await grant_permissions(db_session, user, (TOURNAMENT_ENTER,))
    return user


async def _active_entries(
    db_session: AsyncSession, event_id: uuid.UUID
) -> list[TournamentEntry]:
    rows = await db_session.execute(
        select(TournamentEntry).where(
            TournamentEntry.event_id == event_id,
            TournamentEntry.status == TournamentEntryStatus.entered,
        )
    )
    return list(rows.scalars())


async def _all_entries(
    db_session: AsyncSession, event_id: uuid.UUID
) -> list[TournamentEntry]:
    """Every entry row for an event, whatever its status.

    The "and nothing was written" assertions must use *this*, not
    ``_active_entries``: a handler that inserted the row and then refused could
    leave behind a row that ``_active_entries``' ``status = 'entered'`` filter
    happens to hide, and the test would pass against the bug it exists to catch.
    """
    rows = await db_session.execute(
        select(TournamentEntry).where(TournamentEntry.event_id == event_id)
    )
    return list(rows.scalars())


async def test_the_active_entry_index_is_unique_and_partial(
    db_session: AsyncSession,
) -> None:
    """The guard is a UNIQUE index carrying a ``WHERE status = 'entered'``
    predicate — not a plain unique index over the whole table."""
    indexdef = (
        await db_session.execute(
            text(
                "SELECT indexdef FROM pg_indexes "
                "WHERE tablename = 'tournament_entries' AND indexname = :name"
            ),
            {"name": ACTIVE_ENTRY_INDEX},
        )
    ).scalar_one()

    assert "CREATE UNIQUE INDEX" in indexdef, indexdef
    assert "(event_id, user_id)" in indexdef, indexdef
    assert "WHERE (status = 'entered'" in indexdef, indexdef


async def test_an_entry_persists_with_its_defaults(
    db_session: AsyncSession, event: TournamentEvent, player: User
) -> None:
    entry = TournamentEntry(event_id=event.id, user_id=player.id)
    db_session.add(entry)
    await db_session.commit()
    await db_session.refresh(entry)

    assert entry.id is not None
    assert entry.status is TournamentEntryStatus.entered
    assert entry.seed is None
    assert entry.created_at.tzinfo is not None
    # NULL is the encoding of self-registration, and it is the *default* — a row
    # written without naming an adder says "the player entered themselves"
    # (ADR-0784), which is what every entry made before directors existed is.
    assert entry.added_by_user_id is None


async def test_a_second_active_entry_for_the_same_player_is_rejected(
    db_session: AsyncSession, event: TournamentEvent, player: User
) -> None:
    # Read the ids up front: the rollback below expires every instance in the
    # session, and re-reading ``event.id`` afterwards would attempt lazy IO.
    event_id, user_id = event.id, player.id

    db_session.add(TournamentEntry(event_id=event_id, user_id=user_id))
    await db_session.commit()

    db_session.add(TournamentEntry(event_id=event_id, user_id=user_id))
    with pytest.raises(IntegrityError):
        await db_session.commit()
    await db_session.rollback()

    assert len(await _active_entries(db_session, event_id)) == 1


async def test_withdrawn_player_may_enter_the_same_event_again(
    db_session: AsyncSession, event: TournamentEvent, player: User
) -> None:
    """Enter → withdraw → enter again, all three succeed.

    This is the test a *plain* unique index fails: the withdrawn row still holds
    the ``(event_id, user_id)`` pair, so the re-entry insert would collide.
    """
    first = TournamentEntry(event_id=event.id, user_id=player.id)
    db_session.add(first)
    await db_session.commit()

    first.status = TournamentEntryStatus.withdrawn
    await db_session.commit()

    second = TournamentEntry(event_id=event.id, user_id=player.id)
    db_session.add(second)
    await db_session.commit()

    # The withdrawn row survives alongside the new active one — soft-delete, not
    # a row delete — and exactly one of the two is active.
    all_rows = (
        (
            await db_session.execute(
                select(TournamentEntry).where(TournamentEntry.event_id == event.id)
            )
        )
        .scalars()
        .all()
    )
    assert len(all_rows) == 2
    active = await _active_entries(db_session, event.id)
    assert [e.id for e in active] == [second.id]


async def test_two_withdrawn_rows_for_the_same_pair_coexist(
    db_session: AsyncSession, event: TournamentEvent, player: User
) -> None:
    """The partial index constrains only *active* rows: the withdrawal history
    for one player in one event may be arbitrarily long."""
    for _ in range(2):
        entry = TournamentEntry(event_id=event.id, user_id=player.id)
        db_session.add(entry)
        await db_session.commit()
        entry.status = TournamentEntryStatus.withdrawn
        await db_session.commit()

    rows = (
        (
            await db_session.execute(
                select(TournamentEntry).where(TournamentEntry.event_id == event.id)
            )
        )
        .scalars()
        .all()
    )
    assert len(rows) == 2
    assert all(e.status is TournamentEntryStatus.withdrawn for e in rows)


async def test_two_players_may_both_enter_the_same_event(
    db_session: AsyncSession, event: TournamentEvent, player: User
) -> None:
    """The index keys on the *pair* — it must not collapse an event to one entrant."""
    other = await make_user(db_session, f"player-{uuid.uuid4().hex[:8]}")
    db_session.add_all(
        [
            TournamentEntry(event_id=event.id, user_id=player.id),
            TournamentEntry(event_id=event.id, user_id=other.id),
        ]
    )
    await db_session.commit()

    assert len(await _active_entries(db_session, event.id)) == 2


async def test_deleting_an_event_cascades_its_entries_away(
    db_session: AsyncSession, event: TournamentEvent, player: User
) -> None:
    """A Core ``DELETE`` (not ``session.delete``) so this proves the database's
    ``ON DELETE CASCADE``, not SQLAlchemy's ORM-side cascade."""
    db_session.add(TournamentEntry(event_id=event.id, user_id=player.id))
    await db_session.commit()

    await db_session.execute(
        delete(TournamentEvent).where(TournamentEvent.id == event.id)
    )
    await db_session.commit()

    remaining = (
        (
            await db_session.execute(
                select(TournamentEntry).where(TournamentEntry.event_id == event.id)
            )
        )
        .scalars()
        .all()
    )
    assert remaining == []


async def test_deleting_a_user_with_an_entry_is_restricted(
    db_session: AsyncSession, event: TournamentEvent, player: User
) -> None:
    """``ON DELETE RESTRICT`` on the user FK: an entrant cannot be deleted out
    from under their entry (account-merge tombstones instead — see #781/1f)."""
    db_session.add(TournamentEntry(event_id=event.id, user_id=player.id))
    await db_session.commit()

    with pytest.raises(IntegrityError):
        await db_session.execute(delete(User).where(User.id == player.id))
        await db_session.commit()
    await db_session.rollback()


async def test_an_entry_records_the_director_who_added_it(
    db_session: AsyncSession, event: TournamentEvent, player: User
) -> None:
    """The other half of the ``added_by_user_id`` contract (ADR-0784): a non-null
    adder is a director entry, and it is a distinct row-state from the NULL of
    self-registration. No route reaches this yet (chore 9a) — the column exists so
    that when one does, the fact is recordable rather than lost."""
    director = await make_user(db_session, f"director-{uuid.uuid4().hex[:8]}")

    entry = TournamentEntry(
        event_id=event.id, user_id=player.id, added_by_user_id=director.id
    )
    db_session.add(entry)
    await db_session.commit()
    await db_session.refresh(entry)

    assert entry.added_by_user_id == director.id
    assert entry.user_id == player.id


async def test_deleting_the_director_who_added_an_entry_is_restricted(
    db_session: AsyncSession, event: TournamentEvent, player: User
) -> None:
    """``added_by_user_id`` is ``ON DELETE RESTRICT``, not ``SET NULL``.

    ``SET NULL`` would be the tempting choice for a nullable audit column, and it
    is the wrong one *here* precisely because NULL is not "unknown": it means
    "the player entered themselves". Nulling this column on a delete would not
    lose a fact, it would rewrite one — the entry would start claiming a
    self-registration that never happened. So the database refuses the delete, and
    the merge path (which tombstones rather than deletes) re-points it explicitly.
    """
    director = await make_user(db_session, f"director-{uuid.uuid4().hex[:8]}")
    db_session.add(
        TournamentEntry(
            event_id=event.id, user_id=player.id, added_by_user_id=director.id
        )
    )
    await db_session.commit()

    with pytest.raises(IntegrityError):
        await db_session.execute(delete(User).where(User.id == director.id))
        await db_session.commit()
    await db_session.rollback()


# ----- the self-registration route ------------------------------------------


def _entries_url(event: TournamentEvent) -> str:
    return f"/v1/tournaments/{event.tournament_id}/events/{event.id}/entries"


@pytest_asyncio.fixture
async def entrant_client(
    api_client: AsyncClient, db_session: AsyncSession
) -> AsyncIterator[tuple[AsyncClient, User]]:
    """A real session holding ``tournament.enter`` — and nothing else. The grant
    is deliberately minimal: entering is not gated on ``tournament.view``, and a
    client carrying extra permissions could not tell the two apart."""
    user = await start_session(api_client, db_session)
    await grant_permissions(db_session, user, (TOURNAMENT_ENTER,))
    yield api_client, user


async def test_entering_a_singles_event_returns_201_and_persists_the_row(
    entrant_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    event: TournamentEvent,
) -> None:
    client, user = entrant_client

    response = await client.post(_entries_url(event))

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["user_id"] == str(user.id)
    assert body["username"] == user.username
    assert body["seed"] is None

    (row,) = await _active_entries(db_session, event.id)
    assert row.user_id == user.id
    # Self-registration records NO adder (ADR-0784). The route hard-codes the
    # caller as the entrant, so the one thing that must be true of the row it
    # writes is that nobody "added" the player — they added themselves.
    assert row.added_by_user_id is None
    # The response addresses the row it created: ``id`` is the *entry's* id, which
    # is what a client will withdraw through (``DELETE …/entries/{entry_id}``).
    assert body["id"] == str(row.id)


async def test_entering_the_same_event_twice_is_a_409(
    entrant_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    event: TournamentEvent,
) -> None:
    """Not a 500 (an uncaught IntegrityError), and not a second row.

    The refusal carries the machine-readable ``already_entered`` code (ADR-0968).
    That code, not the sentence beside it, is the contract: the client switches on it
    and writes its own copy. Nothing here asserts on the English — a test that pinned
    the prose would only move the client's byte-matching into the suite, and would
    make the ADR's promise ("rewording a message is now safe") false.
    """
    client, _ = entrant_client
    # The 409 path rolls the shared session back, which expires the ORM instances
    # — read the ids out as plain values first.
    url, event_id = _entries_url(event), event.id

    assert (await client.post(url)).status_code == 201

    duplicate = await client.post(url)

    assert duplicate.status_code == 409, duplicate.text
    assert duplicate.json()["detail"]["code"] == "already_entered"
    assert len(await _active_entries(db_session, event_id)) == 1


async def test_a_player_without_the_enter_permission_is_403(
    api_client: AsyncClient,
    db_session: AsyncSession,
    event: TournamentEvent,
) -> None:
    """Gated on ``tournament.enter`` specifically — a signed-in player who holds
    ``tournament.view`` (so they can see the tournament they are trying to enter)
    is still refused, and writes nothing."""
    user = await start_session(api_client, db_session)
    await grant_permissions(db_session, user, (TOURNAMENT_VIEW,))

    response = await api_client.post(_entries_url(event))

    assert response.status_code == 403, response.text
    assert await _active_entries(db_session, event.id) == []


async def test_entering_a_doubles_event_is_a_400(
    entrant_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    doubles_event: TournamentEvent,
) -> None:
    """One row per user has nowhere to record a partner, so a doubles entry is
    refused outright rather than recorded as half a pair (ADR-0016)."""
    client, _ = entrant_client

    response = await client.post(_entries_url(doubles_event))

    assert response.status_code == 400, response.text
    assert "singles" in response.json()["detail"]
    assert await _active_entries(db_session, doubles_event.id) == []


async def test_a_withdrawn_player_may_enter_again_through_the_route(
    entrant_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    event: TournamentEvent,
) -> None:
    """The discriminating case for the whole slice: enter → withdraw → enter again
    is 201, 201 — not 409.

    A pre-flight ``SELECT`` for "has this player an entry?" would 409 the second
    entry (the withdrawn row is still there); only catching the ``IntegrityError``
    from the *partial* index gets this right. The withdrawal here is done to the
    row directly, which isolates the *enter* route's half of the journey: the same
    journey driven end to end through the real withdraw route is
    ``test_enter_withdraw_then_enter_again_all_succeed_through_the_routes``.
    """
    client, user = entrant_client
    url, event_id = _entries_url(event), event.id

    first = await client.post(url)
    assert first.status_code == 201

    withdrawn_id = uuid.UUID(first.json()["id"])
    entry = await db_session.get(TournamentEntry, withdrawn_id)
    assert entry is not None
    entry.status = TournamentEntryStatus.withdrawn
    await db_session.commit()

    second = await client.post(url)

    assert second.status_code == 201, second.text
    assert second.json()["id"] != str(withdrawn_id)
    # Soft-delete, so both rows survive — but only the new one is active.
    active = await _active_entries(db_session, event_id)
    assert [str(e.id) for e in active] == [second.json()["id"]]
    assert active[0].user_id == user.id


async def test_entering_an_unknown_event_is_a_404(
    entrant_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    event: TournamentEvent,
) -> None:
    """Load-then-authorize: a missing tournament or event is a 404, and an event
    id that exists but belongs to a *different* tournament is one too — the pair
    is what's addressed."""
    client, _ = entrant_client
    missing = uuid.uuid4()
    other = await _make_event(db_session)

    assert (
        await client.post(f"/v1/tournaments/{missing}/events/{event.id}/entries")
    ).status_code == 404
    assert (
        await client.post(
            f"/v1/tournaments/{event.tournament_id}/events/{missing}/entries"
        )
    ).status_code == 404
    # ``other`` really exists — it is only the (tournament, event) pairing that
    # doesn't — so this 404 is the scoping check, not a missing row.
    assert (
        await client.post(
            f"/v1/tournaments/{event.tournament_id}/events/{other.id}/entries"
        )
    ).status_code == 404


async def test_entering_succeeds_while_the_tournament_status_is_published(
    entrant_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """The open half of the registration window (ADR-0017): ``published`` is the
    one status in which entering works, and it is stated here explicitly rather
    than left implicit in the fixture's default."""
    client, user = entrant_client
    event = await _make_event(db_session, status=TournamentStatus.published)

    response = await client.post(_entries_url(event))

    assert response.status_code == 201, response.text
    (row,) = await _active_entries(db_session, event.id)
    assert row.user_id == user.id


@pytest.mark.parametrize(
    "tournament_status",
    [TournamentStatus.draft, TournamentStatus.live, TournamentStatus.archived],
)
async def test_entering_is_a_409_when_the_tournament_status_is_not_published(
    entrant_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    tournament_status: TournamentStatus,
) -> None:
    """The closed half of the window, in all three of its shapes: a ``draft``
    nobody has announced, a ``live`` tournament whose field is fixed, and an
    ``archived`` one that is over. The tournament's status *is* the registration
    window (ADR-0017), so entering outside ``published`` is refused.

    **409, not 403**, and the distinction is the point: the caller holds
    ``tournament.enter`` and the entry would be their own, so they are permitted —
    it is the tournament that is in the wrong state. 403 would say "not you"; the
    truth is "not now".

    And the row: asserting only the status code would pass against a handler that
    inserted the entry and *then* refused, leaving a phantom entrant behind on a
    request that was answered as a failure. ``_all_entries`` is unfiltered, so a
    row written in any status fails this.
    """
    client, _ = entrant_client
    event = await _make_event(db_session, status=tournament_status)
    event_id = event.id

    response = await client.post(_entries_url(event))

    assert response.status_code == 409, response.text
    assert await _all_entries(db_session, event_id) == []


@pytest.mark.parametrize(
    "tournament_status",
    [TournamentStatus.draft, TournamentStatus.live, TournamentStatus.archived],
)
async def test_the_status_refusal_carries_the_registration_closed_code(
    entrant_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    tournament_status: TournamentStatus,
) -> None:
    """All three closed statuses refuse with the **same** code (ADR-0968).

    ``registration_closed`` is what the client switches on — "the window is shut" is
    the fact it must act on, and it acts on it identically whether the tournament has
    not opened yet or is already over. Which of the three it was survives in the
    *message*, and nowhere else, because nothing branches on it.

    This test used to assert a phrase from each sentence ("already under way"), which
    was the client's byte-matching wearing a test's clothes: it made the copy a
    contract, so rewording it for clarity was a breaking change. It asserts the code
    now, and deliberately says nothing about the English — which is what makes the
    reword safe. That the three sentences stay *distinct* is the part still worth
    holding, and ``test_each_closed_status_gets_its_own_refusal_message`` holds it
    without naming any of them.
    """
    client, _ = entrant_client
    event = await _make_event(db_session, status=tournament_status)

    response = await client.post(_entries_url(event))

    assert response.status_code == 409, response.text
    assert response.json()["detail"]["code"] == "registration_closed"


async def test_each_closed_status_gets_its_own_refusal_message(
    entrant_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """One code, three sentences — and the sentences really are three.

    The message is the fallback a client shows for a code it does not recognise, and
    the prose a human reads; "not yet" and "too late" are different things to be told,
    so collapsing the three statuses onto one generic sentence would lose information
    the server has and the reader wants. Asserted as **distinctness**, never as bytes:
    what must hold is that the three refusals are told apart, not that any of them is
    spelled a particular way. Reword all you like — just don't say the same thing
    three times.
    """
    client, _ = entrant_client
    closed = [TournamentStatus.draft, TournamentStatus.live, TournamentStatus.archived]

    messages = []
    for tournament_status in closed:
        event = await _make_event(db_session, status=tournament_status)
        response = await client.post(_entries_url(event))
        assert response.status_code == 409, response.text
        messages.append(response.json()["detail"]["message"])

    assert len(set(messages)) == len(closed), messages
    assert all(messages), "a refusal with no words to fall back on"


async def test_the_doubles_400_outranks_the_status_409(
    entrant_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """A doubles event of a draft tournament is a **400**, not a 409.

    The two refusals are not the same kind of thing. "Not now" invites a retry once
    the tournament is published — but this route will never accept a doubles entry,
    in any status, so answering 409 would send the caller away to come back and be
    refused again. The permanent refusal wins over the transient one.
    """
    client, _ = entrant_client
    event = await _make_event(
        db_session, format=EventFormat.doubles, status=TournamentStatus.draft
    )
    event_id = event.id

    response = await client.post(_entries_url(event))

    assert response.status_code == 400, response.text
    assert "singles" in response.json()["detail"]
    assert await _all_entries(db_session, event_id) == []


# ----- the withdrawal route --------------------------------------------------


def _entry_url(event: TournamentEvent, entry_id: uuid.UUID | str) -> str:
    return f"{_entries_url(event)}/{entry_id}"


async def _enter(client: AsyncClient, event: TournamentEvent) -> uuid.UUID:
    """Enter ``event`` through the real route and return the new entry's id."""
    response = await client.post(_entries_url(event))
    assert response.status_code == 201, response.text
    return uuid.UUID(response.json()["id"])


async def _entries_of(
    db_session: AsyncSession, event_id: uuid.UUID, user_id: uuid.UUID
) -> list[TournamentEntry]:
    """Every entry row for one (event, player) pair — active *and* withdrawn.

    Deliberately unfiltered by status: the tests below assert on what soft-delete
    leaves behind, and a helper that only ever returned active rows could not tell
    a withdrawal apart from a row delete.
    """
    rows = await db_session.execute(
        select(TournamentEntry)
        .where(
            TournamentEntry.event_id == event_id,
            TournamentEntry.user_id == user_id,
        )
        .order_by(TournamentEntry.created_at, TournamentEntry.id)
    )
    return list(rows.scalars())


async def test_withdrawing_soft_deletes_the_entry_and_keeps_the_row(
    entrant_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    event: TournamentEvent,
) -> None:
    """The load-bearing assertion of 1d: the row **survives** the withdrawal.

    Checking only that the entrant vanished from the read path would pass against
    a hard ``DELETE`` too, and would prove nothing — so this queries the row by its
    id and asserts it is still there, now ``withdrawn``. A hard delete fails on the
    ``is not None``; a route that forgot to flip the status fails on the status.
    """
    client, user = entrant_client
    entry_id, event_id = await _enter(client, event), event.id

    response = await client.delete(_entry_url(event, entry_id))

    assert response.status_code == 204, response.text
    assert response.content == b""
    # ``populate_existing`` because the route committed through a *different*
    # session: without it the shared test session could answer from its identity
    # map with the pre-withdrawal row and hide a route that changed nothing.
    row = await db_session.get(TournamentEntry, entry_id, populate_existing=True)
    assert row is not None, "the entry row was deleted — withdrawal must soft-delete"
    assert row.status is TournamentEntryStatus.withdrawn
    assert row.user_id == user.id
    assert await _active_entries(db_session, event_id) == []


async def test_enter_withdraw_then_enter_again_all_succeed_through_the_routes(
    entrant_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    event: TournamentEvent,
) -> None:
    """The discriminating journey of the whole slice, end to end through the real
    routes for the first time: 201 → 204 → **201, not 409**.

    Everything about the design is aimed at this. A *plain* unique index fails it
    (the withdrawn row still squats on the ``(event_id, user_id)`` pair). A
    pre-flight ``SELECT`` for "has this player entered?" instead of the caught
    ``IntegrityError`` fails it. A withdrawal that hard-deleted the row would pass
    it — which is why the soft-delete test above exists alongside it, and why this
    one also asserts both rows survive.
    """
    client, user = entrant_client
    event_id, user_id = event.id, user.id

    first = await _enter(client, event)
    assert (await client.delete(_entry_url(event, first))).status_code == 204

    second_response = await client.post(_entries_url(event))

    assert second_response.status_code == 201, second_response.text
    second = uuid.UUID(second_response.json()["id"])
    assert second != first

    rows = await _entries_of(db_session, event_id, user_id)
    assert [(r.id, r.status) for r in rows] == [
        (first, TournamentEntryStatus.withdrawn),
        (second, TournamentEntryStatus.entered),
    ]


async def test_withdrawing_drops_the_derived_count_and_the_entrants_list(
    api_client: AsyncClient,
    db_session: AsyncSession,
    event: TournamentEvent,
) -> None:
    """What the player actually sees: the event's ``entered`` count falls back to 0
    and they disappear from the entrants list.

    The count is derived from the live *active* entries (ADR-0016), so this is the
    read path proving it honours the soft-delete rather than counting tombstones.
    Needs ``tournament.view`` as well as ``tournament.enter`` — reading a tournament
    and entering one are separate grants.
    """
    user = await start_session(api_client, db_session)
    await grant_permissions(db_session, user, (TOURNAMENT_VIEW, TOURNAMENT_ENTER))
    entry_id = await _enter(api_client, event)

    async def read_event() -> dict:
        response = await api_client.get(f"/v1/tournaments/{event.tournament_id}")
        assert response.status_code == 200, response.text
        (found,) = [e for e in response.json()["events"] if e["id"] == str(event.id)]
        return dict(found)

    entered = await read_event()
    assert entered["entered"] == 1
    assert [e["user_id"] for e in entered["entrants"]] == [str(user.id)]

    assert (await api_client.delete(_entry_url(event, entry_id))).status_code == 204

    withdrawn = await read_event()
    assert withdrawn["entered"] == 0
    assert withdrawn["entrants"] == []


async def test_withdrawing_another_players_entry_is_a_403(
    entrant_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    event: TournamentEvent,
) -> None:
    """403 on someone else's entry — and it is the *ownership* check that refuses.

    The rival holds ``tournament.enter`` too, so the ``require_enter`` gate lets
    them through: a withdraw route with no ownership check at all would fail here.
    Their entry is untouched afterwards, so the refusal is not a partial write.
    """
    client, _ = entrant_client
    async with make_client() as rival_client:
        rival = await start_session(rival_client, db_session)
        await grant_permissions(db_session, rival, (TOURNAMENT_ENTER,))
        rival_entry = await _enter(rival_client, event)
        event_id, rival_id = event.id, rival.id

        response = await client.delete(_entry_url(event, rival_entry))

    assert response.status_code == 403, response.text
    assert response.json()["detail"] == "You can only withdraw your own entry."
    (row,) = await _entries_of(db_session, event_id, rival_id)
    assert row.status is TournamentEntryStatus.entered


async def test_withdrawing_an_already_withdrawn_entry_is_idempotent(
    entrant_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    event: TournamentEvent,
) -> None:
    """Withdrawing twice is a 204 both times — asking for a state the resource is
    already in is a success, not a conflict. And the second call writes nothing:
    still exactly one row for the pair, still withdrawn."""
    client, user = entrant_client
    entry_id, event_id, user_id = await _enter(client, event), event.id, user.id

    first = await client.delete(_entry_url(event, entry_id))
    second = await client.delete(_entry_url(event, entry_id))

    assert (first.status_code, second.status_code) == (204, 204), second.text
    rows = await _entries_of(db_session, event_id, user_id)
    assert [(r.id, r.status) for r in rows] == [
        (entry_id, TournamentEntryStatus.withdrawn)
    ]


async def _seed_entry(
    db_session: AsyncSession,
    event: TournamentEvent,
    user: User,
    status: TournamentEntryStatus = TournamentEntryStatus.entered,
) -> uuid.UUID:
    """An entry for ``user`` in ``event``, in ``status``, written straight to the
    database — the withdrawal-gate tests' precondition.

    It cannot be built through the routes any more, which is the whole reason this
    exists: entering is *itself* gated on ``published`` (2a), so a fixture that
    walked ``POST`` → optional ``DELETE`` could only ever leave an entry under a
    published tournament — precisely the one status the tests below are not about.
    Writing the row directly is also what keeps them honest: the same rule
    ``_make_event`` follows for the tournament's status column, for the same reason
    — a bug in one gate must not be able to build the other gate's preconditions and
    so hide itself.
    """
    entry = TournamentEntry(event_id=event.id, user_id=user.id, status=status)
    db_session.add(entry)
    await db_session.commit()
    await db_session.refresh(entry)
    return entry.id


async def _reread(db_session: AsyncSession, entry_id: uuid.UUID) -> TournamentEntry:
    """The entry as the *database* now holds it, not as this session remembers it.

    ``populate_existing`` is load-bearing here, not decoration. ``_seed_entry`` put
    the row in this session's identity map, and the routes commit through a
    *different* session — so a plain read would answer ``entered`` from cache even
    after a buggy handler had flipped the row and committed. Every "and it is still
    ``entered``" assertion below would then pass against the exact handler it exists
    to catch: the one that writes the withdrawal and only *then* refuses.
    """
    row = await db_session.get(TournamentEntry, entry_id, populate_existing=True)
    assert row is not None, "the entry row vanished — withdrawal must soft-delete"
    return row


async def test_withdrawing_succeeds_while_the_tournament_status_is_published(
    entrant_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """The open half of the window, from the withdrawal side: while a tournament is
    ``published`` its entries are still fluid, so a player may take theirs back."""
    client, user = entrant_client
    event = await _make_event(db_session, status=TournamentStatus.published)
    entry_id = await _seed_entry(db_session, event, user)

    response = await client.delete(_entry_url(event, entry_id))

    assert response.status_code == 204, response.text
    assert (
        await _reread(db_session, entry_id)
    ).status is TournamentEntryStatus.withdrawn


@pytest.mark.parametrize(
    "tournament_status",
    [TournamentStatus.draft, TournamentStatus.live, TournamentStatus.archived],
)
async def test_withdrawing_an_active_entry_is_a_409_outside_published(
    entrant_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    tournament_status: TournamentStatus,
) -> None:
    """Going live *locks the entries* (ADR-0017), and this is what that means: an
    active entry cannot be withdrawn once the tournament has left ``published``.
    Withdrawing from a ``live`` tournament would pull a player out from under a draw
    generated from the field they were part of. ``draft`` and ``archived`` are shut
    for their own reasons — registration has not opened; it is over.

    **409, not 403**: the caller holds ``tournament.enter`` and it is their own
    entry, so they are permitted. It is the tournament that is in the wrong state.

    And the row is re-read: a status-code-only assertion would pass against a
    handler that flipped the entry to ``withdrawn`` and *then* refused — answering
    409 while having already done the very thing it refused.
    """
    client, user = entrant_client
    event = await _make_event(db_session, status=tournament_status)
    entry_id = await _seed_entry(db_session, event, user)

    response = await client.delete(_entry_url(event, entry_id))

    assert response.status_code == 409, response.text
    assert (await _reread(db_session, entry_id)).status is TournamentEntryStatus.entered


@pytest.mark.parametrize("tournament_status", list(TournamentStatus))
async def test_withdrawing_an_already_withdrawn_entry_is_204_in_every_status(
    entrant_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    tournament_status: TournamentStatus,
) -> None:
    """The idempotency exception, and the test a *blunt* status gate fails.

    ADR-0016 made "withdrawing an already-withdrawn entry is a 204" a designed
    invariant — this is ``DELETE``, and asking for a state the resource is already
    in is a success. ADR-0017's lock must not quietly repeal it. So the gate is on
    the state **change**, not on the call: an entry that is already ``withdrawn``
    has nothing left to lock, and a request that would change *nothing* has no
    conflict in it to answer 409 with.

    Hence all four statuses, ``live`` and ``archived`` emphatically included — those
    are the two a gate written as "refuse unless published" would break, turning a
    no-op into a conflict. The parametrization is over the whole enum on purpose: a
    fifth status added tomorrow inherits this test rather than escaping it.
    """
    client, user = entrant_client
    event = await _make_event(db_session, status=tournament_status)
    entry_id = await _seed_entry(
        db_session, event, user, status=TournamentEntryStatus.withdrawn
    )

    response = await client.delete(_entry_url(event, entry_id))

    assert response.status_code == 204, response.text
    assert response.content == b""
    assert (
        await _reread(db_session, entry_id)
    ).status is TournamentEntryStatus.withdrawn


async def test_the_ownership_403_outranks_the_status_409_on_a_live_tournament(
    entrant_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """Someone else's active entry in a **live** tournament is a 403, not a 409 —
    the one case where both refusals are plausible, and so the only one that
    actually pins the order.

    "Not yours" outranks "not now" because it is the fact that will not change: a
    409 invites the caller back once the tournament is published, where the entry
    will still not be theirs to withdraw. Same shape as the enter route's doubles
    400 beating its status 409 — every permanent refusal is answered before any
    transient one. The rival's entry is untouched, so the 403 is not a partial write.
    """
    client, _ = entrant_client
    event = await _make_event(db_session, status=TournamentStatus.live)
    rival = await make_user(db_session, f"rival-{uuid.uuid4().hex[:8]}")
    rival_entry = await _seed_entry(db_session, event, rival)

    response = await client.delete(_entry_url(event, rival_entry))

    assert response.status_code == 403, response.text
    assert response.json()["detail"] == "You can only withdraw your own entry."
    assert (
        await _reread(db_session, rival_entry)
    ).status is TournamentEntryStatus.entered


async def test_withdrawing_an_entry_that_isnt_addressable_here_is_a_404(
    entrant_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    event: TournamentEvent,
) -> None:
    """Load-then-authorize, one level deeper than the enter route: an unknown entry
    id is a 404, and so is a *real* entry of the caller's own reached through the
    wrong event — the whole (tournament, event, entry) triple is what's addressed.
    The misaddressed entry is left entered, so a 404 never withdraws anything.
    """
    client, user = entrant_client
    other_event = await _make_event(db_session)
    elsewhere = await _enter(client, other_event)
    other_event_id, user_id = other_event.id, user.id

    assert (await client.delete(_entry_url(event, uuid.uuid4()))).status_code == 404, (
        "an entry id that exists nowhere"
    )
    assert (await client.delete(_entry_url(event, elsewhere))).status_code == 404, (
        "a real entry of the caller's, but not in this event"
    )

    (row,) = await _entries_of(db_session, other_event_id, user_id)
    assert row.status is TournamentEntryStatus.entered


# ----- the guard fails closed -------------------------------------------------


async def test_a_closed_window_refuses_even_when_the_status_is_published(
    entrant_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When ``_registration_open`` says shut, the routes refuse — whatever the
    *status* happens to be.

    ``_registration_open`` is the single source of truth every registration rule is
    meant to hang off (a deadline, a capacity cap, #784), and today it is exactly
    "status is published". Tomorrow it is not — so this test asks the question that
    tomorrow asks: a ``published`` tournament whose window the predicate has closed
    for some *other* reason. The predicate is stubbed rather than a second rule
    being invented for the test, because the point is precisely that the enforcer
    must not care *why* it was told no.

    This is a regression test for a guard that failed **open**: it refused only if
    it could independently re-derive "the status is not published", so a
    ``published``-but-closed tournament fell through every branch and the write it
    was asked to refuse went through. A guard may never fail in the permissive
    direction — and the refusal it gives here is generic, because the status is not
    the reason and saying it was would be a lie.

    Two events, because the two legs must be able to fail for their *own* reason: a
    player entering an event they already hold an entry in would be refused by the
    duplicate-entry index whatever this guard did, and that 409 would sit on top of
    the fail-open bug and hide it.
    """
    client, user = entrant_client
    to_enter = await _make_event(db_session, status=TournamentStatus.published)
    to_withdraw = await _make_event(db_session, status=TournamentStatus.published)
    entry_id = await _seed_entry(db_session, to_withdraw, user)
    to_enter_id = to_enter.id
    # The single registration-window decision now lives in
    # ``app.tournament_registration``
    # (both the entry verb and the withdraw route call it module-qualified), so stubbing
    # that one attribute closes the window for BOTH legs below.
    monkeypatch.setattr(
        "app.tournament_registration.registration_open", lambda t: False
    )

    entering = await client.post(_entries_url(to_enter))
    withdrawing = await client.delete(_entry_url(to_withdraw, entry_id))

    assert entering.status_code == 409, entering.text
    # The same ``registration_closed`` code as a draft/live/archived refusal: the
    # window is shut, and the client acts on that regardless of *what* shut it. The
    # generic sentence rides along in the message, where a status that is not the
    # reason cannot be misreported as one.
    assert entering.json()["detail"]["code"] == "registration_closed"
    assert withdrawing.status_code == 409, withdrawing.text
    # And neither refusal wrote: no entry row at all in the event that was entered,
    # and the withdrawn-from one's entry still active — re-read from the database,
    # since a refusal that had already flipped it would otherwise answer from this
    # session's identity map and read as clean.
    assert await _all_entries(db_session, to_enter_id) == []
    assert (await _reread(db_session, entry_id)).status is TournamentEntryStatus.entered


# ----- the go-live race ------------------------------------------------------
#
# "Going live locks the entries" (ADR-0017) is a claim about *time*, and the two
# tests below are the only ones here that test it as one. Every other status test
# in this file puts the tournament in a status and then knocks on the door — which
# a handler that reads the status and writes without a lock passes easily. The bug
# lives in the gap between that read and that write: under READ COMMITTED an
# unlocked read is answered from the snapshot of that statement alone, so an entry
# can pass a ``published`` check and commit *behind* a go-live that landed while it
# was still in flight, leaving a row in the field the draw (#785) is cut from that
# arrived after the field was supposed to be sealed. Withdrawal has the mirror bug.
#
# So these two drive the gap directly: two sessions on two connections, with the
# go-live decided-but-uncommitted while the entry/withdrawal arrives. They are not
# timing-dependent — the blocked side is *made* to block by Postgres, and released
# by an explicit commit — so there is nothing here to flake.


async def _hold_the_go_live_lock(
    session: AsyncSession, tournament_id: uuid.UUID
) -> None:
    """Take the owner's go-live up to, but not including, its commit.

    The tournament row is locked ``FOR UPDATE`` and already flipped to ``live``
    inside this transaction — and invisible to everyone else until it commits. That
    is precisely the instant the race lives in, and holding it open is what lets a
    test drive the other half of the race deterministically rather than firing both
    sides and hoping the scheduler interleaves them the interesting way.

    The lock is taken the way the transition route takes it, because it is the
    *route's* lock the other side must collide with.
    """
    tournament = (
        await session.execute(
            select(Tournament).where(Tournament.id == tournament_id).with_for_update()
        )
    ).scalar_one()
    tournament.status = TournamentStatus.live
    await session.flush()


async def test_an_entry_cannot_land_after_the_tournament_has_gone_live(
    db_session: AsyncSession,
    engine: AsyncEngine,
    event: TournamentEvent,
    player: User,
) -> None:
    """An entry in flight when the owner presses go-live is refused, not accepted.

    The owner's go-live holds the tournament's row lock, uncommitted. The player's
    entry arrives and reads the tournament — and *blocks*, because the entry route
    reads it ``FOR UPDATE`` as well. When the go-live commits, that read returns
    ``live``, the status gate refuses, and no row is written.

    Without the lock the entry is never made to wait (which is what
    ``entering.done()`` catches first): it reads ``published`` from its own
    snapshot, passes the gate, and commits its INSERT behind the go-live. Two
    successful requests, and a sealed field with an extra entrant in it.
    """
    tournament_id, event_id, player_id = event.tournament_id, event.id, player.id
    make_session = async_sessionmaker(engine, expire_on_commit=False)

    async def enter() -> int | str:
        async with make_session() as session:
            entrant = (
                await session.execute(select(User).where(User.id == player_id))
            ).scalar_one()
            try:
                # ``None`` is the body: self-registration (ADR-0784). The director's
                # arm of the same handler takes a ``TournamentEntryCreate``.
                await enter_event(tournament_id, event_id, None, session, entrant)
                return "entered"
            except HTTPException as exc:
                return exc.status_code

    async with make_session() as go_live:
        await _hold_the_go_live_lock(go_live, tournament_id)
        entering = asyncio.create_task(enter())
        # Every chance to finish — and it cannot, because it is parked on the
        # tournament's row lock, inside the handler, before its status check.
        await asyncio.sleep(0.25)
        if entering.done():
            pytest.fail(
                "the entry did not block on the tournament's row lock: it ran to "
                f"completion against an uncommitted go-live ({entering.result()!r})"
            )
        await go_live.commit()
        outcome = await entering

    assert outcome == 409, outcome
    assert await _all_entries(db_session, event_id) == []


async def test_an_active_entry_cannot_be_withdrawn_after_the_tournament_goes_live(
    db_session: AsyncSession,
    engine: AsyncEngine,
    event: TournamentEvent,
    player: User,
) -> None:
    """The mirror: a withdrawal in flight when the owner presses go-live is refused.

    Same two sessions, same held lock. A withdrawal that slipped through would pull
    a player out from under a draw cut from the field they were part of — so the
    withdrawal route takes the same lock, on the same row, in the same order (which
    is also why no two of these three routes can deadlock against each other), and
    the entry is still ``entered`` when the dust settles.
    """
    entry_id = await _seed_entry(db_session, event, player)
    tournament_id, event_id, player_id = event.tournament_id, event.id, player.id
    make_session = async_sessionmaker(engine, expire_on_commit=False)

    async def withdraw() -> int | str:
        async with make_session() as session:
            actor = (
                await session.execute(select(User).where(User.id == player_id))
            ).scalar_one()
            try:
                await withdraw_from_event(
                    tournament_id, event_id, entry_id, session, actor
                )
                return "withdrawn"
            except HTTPException as exc:
                return exc.status_code

    async with make_session() as go_live:
        await _hold_the_go_live_lock(go_live, tournament_id)
        withdrawing = asyncio.create_task(withdraw())
        await asyncio.sleep(0.25)
        if withdrawing.done():
            pytest.fail(
                "the withdrawal did not block on the tournament's row lock: it ran to "
                f"completion against an uncommitted go-live ({withdrawing.result()!r})"
            )
        await go_live.commit()
        outcome = await withdrawing

    assert outcome == 409, outcome
    assert (await _reread(db_session, entry_id)).status is TournamentEntryStatus.entered


# ----- capacity (ADR-0783, §4) -----------------------------------------------
#
# ``max_players`` is a column on the EVENT; the field is rows in
# ``tournament_entries``. "The event is full" is therefore a COUNT compared against a
# column on another table — which no database constraint can express. That is the
# whole difficulty, and it is what makes this guard unlike the duplicate-entry one
# beside it: there, the *partial unique index* is the enforcement and the route
# merely translates the IntegrityError, so a race is impossible however the code is
# written. Here nothing underneath us says no. The tournament's row lock is the only
# mechanism, so the count must happen inside it — and the test that proves it must be
# a race (``test_two_entrants_racing_for_the_last_slot_yield_exactly_one_entry``),
# because every sequential test below passes just as happily against a count taken
# outside the lock.


def _statement_index(
    statements: list[str], matches: Callable[[str], bool], *, label: str
) -> int:
    """Where ``label``'s statement appears in the emitted SQL — and a legible failure
    when it does not appear at all.

    Deliberately not a bare ``next(i for i, s in ...)``: inside a coroutine, the
    ``StopIteration`` a missing statement raises is re-raised by the event loop as
    ``RuntimeError: coroutine raised StopIteration`` — which is what a *dropped lock*
    looks like, i.e. the exact bug this test exists to name, reported as a plumbing
    error with no mention of SQL.
    """
    for index, statement in enumerate(statements):
        if matches(statement):
            return index
    raise AssertionError(f"no statement emitted for {label}: {statements}")


async def test_the_last_slot_is_enterable(
    entrant_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    player: User,
) -> None:
    """The **Nth** entrant is admitted: the event is full *at* ``max_players``, not
    one short of it. An off-by-one in the other direction would quietly shrink every
    event on the platform by a player."""
    client, user = entrant_client
    event = await _make_event(db_session, max_players=2)
    await _seed_entry(db_session, event, player)

    response = await client.post(_entries_url(event))

    assert response.status_code == 201, response.text
    assert len(await _active_entries(db_session, event.id)) == 2


async def test_entering_a_full_event_is_a_409_with_the_event_full_code(
    entrant_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    player: User,
) -> None:
    """The **N+1th** entrant is refused, with the machine-readable ``event_full`` code
    (ADR-0968) — and no row is written.

    ``_all_entries``, not ``_active_entries``: a handler that inserted the entry and
    only *then* noticed the event was full would leave a row behind that the active
    filter might hide, and this test would pass against the bug it exists to catch.
    """
    client, _ = entrant_client
    event = await _make_event(db_session, max_players=1)
    event_id = event.id
    await _seed_entry(db_session, event, player)

    response = await client.post(_entries_url(event))

    assert response.status_code == 409, response.text
    assert response.json()["detail"]["code"] == "event_full"
    assert response.json()["detail"]["message"], (
        "a refusal with no words to fall back on"
    )
    assert len(await _all_entries(db_session, event_id)) == 1


async def test_a_withdrawn_entry_does_not_occupy_a_slot(
    entrant_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    player: User,
) -> None:
    """Capacity counts **active** entries only (ADR-0016).

    A withdrawn entry's row survives the withdrawal, so a ``COUNT(*)`` that forgot the
    ``status = 'entered'`` filter would seal a one-player event that in truth has
    nobody in it — and would seal it *permanently*, since withdrawing is the one thing
    that is supposed to free the slot back up.
    """
    client, user = entrant_client
    event = await _make_event(db_session, max_players=1)
    await _seed_entry(db_session, event, player, status=TournamentEntryStatus.withdrawn)

    response = await client.post(_entries_url(event))

    assert response.status_code == 201, response.text
    active = await _active_entries(db_session, event.id)
    assert [e.user_id for e in active] == [user.id]


async def test_an_uncapped_event_never_refuses_with_event_full(
    entrant_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """An event with **no cap** (``max_players IS NULL``, ADR-0935) admits everybody,
    however many are already in it — the ``event_full`` refusal is unreachable for it.

    The field is seeded well past every cap this file uses, so the assertion is not
    "one more fits" but "the limit does not exist": against the pre-ADR-0935 guard
    (``entered >= max_players`` over a NULL) this is a ``TypeError`` and a 500, and
    against the tempting repair (``max_players or 0``) it is a 409 on an *empty* event
    — the uncapped event, the one that admits everybody, being the only one nobody can
    enter. Both failures land here, and neither can hide behind a green capped test.
    """
    client, user = entrant_client
    event = await _make_event(db_session, max_players=None)
    for index in range(5):
        await _seed_entry(
            db_session, event, await make_user(db_session, f"crowd-{index}")
        )

    response = await client.post(_entries_url(event))

    assert response.status_code == 201, response.text
    active = await _active_entries(db_session, event.id)
    assert len(active) == 6
    assert user.id in {entry.user_id for entry in active}


async def test_an_uncapped_event_takes_no_capacity_count(
    db_session: AsyncSession,
    engine: AsyncEngine,
    player: User,
) -> None:
    """No cap, no count: the guard steps aside *before* the ``COUNT(*)``, rather than
    counting the field and then ignoring the number.

    The count is not free — it is a scan of the entries of an event that, being
    uncapped, is likely to be the biggest one there is — and its answer could not change
    the outcome, because there is nothing to compare it against. A query whose result is
    discarded is a query that should not have been issued; this is the tripwire that
    says so, and it is the reason the ``None`` check sits above the count and not below
    it.
    """
    event = await _make_event(db_session, max_players=None)
    tournament_id, event_id, player_id = event.tournament_id, event.id, player.id

    async with counted_statements(engine) as (session, statements):
        entrant = (
            await session.execute(select(User).where(User.id == player_id))
        ).scalar_one()
        await enter_event(tournament_id, event_id, None, session, entrant)

    assert not any(
        "count(" in statement.lower() and "tournament_entries" in statement
        for statement in statements
    ), statements
    # The lock is still taken, though: an uncapped event is not an unlocked one. The
    # tournament's status is still judged and then written against (registration window,
    # ADR-0017), and dropping the capacity count must not drop the lock with it.
    assert any("FOR UPDATE" in statement for statement in statements), statements


async def test_the_capacity_count_is_taken_under_the_tournament_row_lock(
    db_session: AsyncSession,
    engine: AsyncEngine,
    event: TournamentEvent,
    player: User,
) -> None:
    """A statement-order tripwire on the thing the race below actually depends on: the
    ``SELECT count(*)`` is emitted **after** the ``FOR UPDATE``, and **before** the
    ``INSERT``.

    The race test is the proof; this is the message. When someone hoists the count for
    tidiness — say, into a helper that runs before the tournament is loaded — the race
    goes red with a timing-flavoured failure that reads like flake, while this one goes
    red saying precisely what broke.
    """
    tournament_id, event_id, player_id = event.tournament_id, event.id, player.id

    async with counted_statements(engine) as (session, statements):
        entrant = (
            await session.execute(select(User).where(User.id == player_id))
        ).scalar_one()
        await enter_event(tournament_id, event_id, None, session, entrant)

    lock = _statement_index(
        statements, lambda s: "FOR UPDATE" in s, label="the tournament row lock"
    )
    count = _statement_index(
        statements,
        lambda s: "count(" in s.lower() and "tournament_entries" in s,
        label="the capacity COUNT over tournament_entries",
    )
    insert = _statement_index(
        statements,
        lambda s: s.lstrip().upper().startswith("INSERT INTO TOURNAMENT_ENTRIES"),
        label="the entry INSERT",
    )
    assert lock < count < insert, statements
    assert len(await _active_entries(db_session, event_id)) == 1


async def test_two_entrants_racing_for_the_last_slot_yield_exactly_one_entry(
    db_session: AsyncSession,
    engine: AsyncEngine,
    player: User,
) -> None:
    """**The test this whole chore exists for.** Two players, one slot, both requests
    in flight at once: one 201, one ``event_full`` 409, and exactly one row.

    Capacity cannot be a database constraint — it is a count on one table compared
    against a column on another — so unlike the duplicate-entry guard beside it there
    is no unique index to catch a loser that slipped through. The count-then-INSERT is
    safe only because it happens *inside* the tournament's row lock, which every entry
    to every event of that tournament takes, first and in the same order.

    **The race is staged, not hoped for.** A gatekeeper session holds the tournament's
    row lock — exactly as an in-flight entry (or a go-live) would — and both entrants
    are launched into the handler while it is held. Two things are then true by
    construction rather than by scheduler luck:

    * Both entrants must **block**, before deciding anything, on the same lock. An
      implementation that reads the tournament unlocked never waits, runs both counts
      against its own snapshot ("0 of 1 taken"), and answers both — which
      ``entering.done()`` catches here with a message, and which two ``asyncio.gather``
      -ed tasks would only catch when the scheduler happened to interleave them the
      damning way.
    * Both entrants' counts happen *after* the lock is released — so a count hoisted
      **above** the lock (the tidying refactor that quietly reintroduces the bug) has
      both of them reading zero while parked, and both insert. Two entrants in an event
      with room for one.

    Verified against both of those broken shapes: each turns this test red. With the
    count under the lock, the loser blocks, re-reads the field the winner *committed*,
    and is refused.
    """
    event = await _make_event(db_session, max_players=1)
    tournament_id, event_id = event.tournament_id, event.id
    rival = await make_user(db_session, f"rival-{uuid.uuid4().hex[:8]}")
    # Both contenders hold ``tournament.enter``: the self-registration arm of the fork
    # checks it inside the handler now (ADR-0784), and a contender without it would be
    # refused before it ever reached the lock — which would leave the "two entrants,
    # one slot" race with only one entrant in it, and green for the wrong reason.
    await grant_permissions(db_session, rival, (TOURNAMENT_ENTER,))
    contenders = [player.id, rival.id]
    make_session = async_sessionmaker(engine, expire_on_commit=False)

    async def enter(user_id: uuid.UUID) -> str:
        async with make_session() as session:
            entrant = (
                await session.execute(select(User).where(User.id == user_id))
            ).scalar_one()
            try:
                await enter_event(tournament_id, event_id, None, session, entrant)
                return "entered"
            except HTTPException as exc:
                # The refusal's *code*, not just its status: a 409 that came from
                # somewhere else (a duplicate entry, a closed window) would otherwise
                # read as a pass for the capacity guard.
                assert isinstance(exc.detail, dict), exc.detail
                return f"{exc.status_code} {exc.detail['code']}"

    async with make_session() as gatekeeper:
        # The tournament's row lock, held and uncommitted — the same lock, on the same
        # row, that the entry route takes first. Nothing is modified: this stands in
        # for a *concurrent entry* that has the lock right now, which is precisely the
        # instant the last slot is contested in.
        await gatekeeper.execute(
            select(Tournament).where(Tournament.id == tournament_id).with_for_update()
        )
        racing = [asyncio.create_task(enter(user_id)) for user_id in contenders]
        # Every chance to finish — and neither may, because both are parked on that
        # lock, inside the handler, before either has counted anything.
        await asyncio.sleep(0.25)
        ran_ahead = [task for task in racing if task.done()]
        if ran_ahead:
            for task in racing:
                task.cancel()
            pytest.fail(
                "an entry did not block on the tournament's row lock: it decided "
                "capacity against its own snapshot while another transaction held "
                f"the row ({[task.result() for task in ran_ahead]!r}) — the count is "
                "not under the lock, and two entrants can take the same last slot"
            )
        await gatekeeper.rollback()
        outcomes = await asyncio.gather(*racing)

    assert sorted(outcomes) == ["409 event_full", "entered"], outcomes
    # And the field itself: one entrant, in an event with room for one. Re-read on a
    # session of its own — the loser's transaction rolled back, and a count taken from
    # the winner's would only be answering about its own snapshot.
    async with make_session() as verify:
        assert len(await _active_entries(verify, event_id)) == 1


# ----- eligibility: the event's rating rules (ADR-0783) ----------------------
#
# The *decision* is unit-tested where it lives: ``tests/test_tournament_eligibility.py``
# runs every operator at, above and below its boundary, with no database at all. What is
# tested HERE is the wiring those unit tests cannot see: that the route reads the rating
# on the **tournament's** league, refuses with the ``rating_ineligible`` code, writes no
# row when it refuses, and answers the eligibility refusal *before* the capacity one.
#
# And the one rule that has to be pinned on both sides, because it is the one somebody
# will "fix": **an unrated player enters a capped event** (ADR-0783 §3).

CAP_UNDER_1500: list[dict[str, Any]] = [
    {"id": "pr-cap", "field": "rating", "op": "<", "value": 1500}
]


# The rating helper lives in ``tests/_helpers.py`` (``rate_player``): the detail
# read's ``entry_state`` tests need the very same "actually rated, not merely seeded"
# setup, and a second copy of it is exactly how one side of ADR-0783 ends up testing
# nothing.
_rate = rate_player


async def test_a_player_over_the_events_rating_cap_is_refused_as_rating_ineligible(
    entrant_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """A 1650-rated player, an "Under 1500" event: 409 ``rating_ineligible``, no row.

    ``_all_entries``, not ``_active_entries``: a handler that inserted the entry and
    only then judged the rating would leave a row behind that the active filter might
    hide, and this test would pass against the bug it exists to catch.
    """
    client, user = entrant_client
    await _rate(db_session, user, default_league, 1650.0)
    event = await _make_event(db_session, predicates=CAP_UNDER_1500)
    event_id = event.id

    response = await client.post(_entries_url(event))

    assert response.status_code == 409, response.text
    assert response.json()["detail"]["code"] == "rating_ineligible"
    # The message is a fallback, not the contract (ADR-0968) — but a refusal with no
    # words at all leaves a client that doesn't know the code with nothing to say.
    assert response.json()["detail"]["message"], (
        "a refusal with no words to fall back on"
    )
    assert await _all_entries(db_session, event_id) == []


async def test_a_player_under_the_events_rating_cap_enters(
    entrant_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """The other half of the same rule, and the one that proves the guard is not simply
    refusing everybody: 1400 is under the 1500 cap, so the entry lands."""
    client, user = entrant_client
    await _rate(db_session, user, default_league, 1400.0)
    event = await _make_event(db_session, predicates=CAP_UNDER_1500)

    response = await client.post(_entries_url(event))

    assert response.status_code == 201, response.text
    assert [e.user_id for e in await _active_entries(db_session, event.id)] == [user.id]


async def test_an_unrated_player_enters_a_capped_event(
    entrant_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """**A player with NO rating enters the "Under 1500" event.** 201, not 409.

    This is the counterintuitive rule of ADR-0783 §3, and it is deliberate. A player
    holds no rating on a league until they finish a rated match there, so the brand-new
    player — the one the beginners' event exists *for* — has nothing to compare against
    the cap. Refusing them would lock them out of the only event they belong in, and it
    would do so on the strength of a fact we do not have.

    The known cost, accepted rather than overlooked: this makes a rating cap **opt-out**
    (a sandbagger can stay unrated forever). It is mitigated by *marking* unrated
    entrants in the entrants list, where a director can act on it — not by guessing a
    rating.

    **This entrant is the production shape of "unrated", which is the part with teeth.**
    No ``_rate`` call — but they are *not* a player with no rating row: minting their
    session joined them to the default league, which seeded a ``user_league_ratings``
    row at **1500** and an ``initial`` rating-history event, before they had played
    anything (``app.ratings.rated``). A guard that read ``rating_value`` off that row
    would compare 1500 against ``rating < 1500``, refuse them, and lock every beginner
    on the platform out of the beginners' event — the exact harm §3 forbids, arriving by
    the back door. It passes only because eligibility asks ``is_rated_member``: has
    anything real MOVED this rating? Nothing has. They are Unrated, and they enter.
    """
    client, user = entrant_client
    event = await _make_event(db_session, predicates=CAP_UNDER_1500)
    # The seed is really there — the assertion below is not about an empty table.
    seeded = (
        await db_session.execute(
            select(UserLeagueRating.rating_value).where(
                UserLeagueRating.user_id == user.id
            )
        )
    ).scalar_one()
    assert seeded == 1500.0, "the session mint seeds a 1500 prior; that is the trap"

    response = await client.post(_entries_url(event))

    assert response.status_code == 201, response.text
    assert [e.user_id for e in await _active_entries(db_session, event.id)] == [user.id]
    # And the entrant it answers with says so: ``rating: null``, NOT the 1500 asserted
    # above. The entry the director sees in the list and the entry the player's own POST
    # returned are the same shape, marked the same way (ADR-0783 §3).
    assert response.json()["rating"] is None


async def test_the_created_entrant_carries_the_rating_it_was_judged_on(
    entrant_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """A rated player's 201 carries their rating on the tournament's ladder — the very
    number the eligibility guard just compared against the event's rules.

    It is read ONCE, by that guard, and handed to the response: a second read after the
    INSERT would be an extra query for a number already in hand, and could answer
    differently from the one that admitted them.
    """
    client, user = entrant_client
    await _rate(db_session, user, default_league, 1432.0)
    event = await _make_event(db_session, predicates=CAP_UNDER_1500)

    response = await client.post(_entries_url(event))

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["rating"] == 1432.0
    assert body["user_id"] == str(user.id)


async def test_a_player_with_a_null_rating_on_the_ladder_enters_a_capped_event(
    entrant_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """The *other* way to be unrated: a NULL ``rating_value`` — a manual ladder the
    player is on, whose rating has not been imported yet.

    Deliberately the awkward one: this player has real *provenance* (a non-``initial``
    rating-history row, so they pass the "something moved it" half of
    ``is_rated_member`` outright) and no number. A guard that took provenance as proof
    of a rating would hand ``None`` to the evaluator as if it were one, and either 500
    comparing ``None`` to 1500 or read it as a zero and admit them for entirely the
    wrong reason. They enter because they are Unrated — the same reason as everybody
    else here.
    """
    client, user = entrant_client
    await _rate(db_session, user, default_league, 1650.0)
    rating = (
        await db_session.execute(
            select(UserLeagueRating).where(
                UserLeagueRating.league_id == default_league.id,
                UserLeagueRating.user_id == user.id,
            )
        )
    ).scalar_one()
    rating.rating_value = None
    await db_session.commit()
    event = await _make_event(db_session, predicates=CAP_UNDER_1500)

    response = await client.post(_entries_url(event))

    assert response.status_code == 201, response.text
    assert len(await _active_entries(db_session, event.id)) == 1


async def test_eligibility_is_judged_on_the_tournaments_league_not_any_other(
    entrant_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """The rating that decides an entry is the player's rating on the **tournament's**
    ladder (ADR-0783 §2) — the league the tournament named when it was created.

    The player is 1650 on the *default* league and unrated on the league this tournament
    is actually run on, so they enter: an evaluator that grabbed "the player's rating"
    from whatever row it found first would refuse them, and this is the test that tells
    the two apart.
    """
    client, user = entrant_client
    await _rate(db_session, user, default_league, 1650.0)
    other = League(
        name="Club Ladder",
        description="Not the default — and this tournament's ladder.",
        visibility=LeagueVisibility.private,
        rating_strategy_id=default_league.rating_strategy_id,
    )
    db_session.add(other)
    await db_session.commit()
    await db_session.refresh(other)
    event = await _make_event(db_session, predicates=CAP_UNDER_1500, league=other)

    response = await client.post(_entries_url(event))

    assert response.status_code == 201, response.text
    assert len(await _active_entries(db_session, event.id)) == 1


async def test_every_rule_must_be_satisfied_not_merely_one_of_them(
    entrant_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """Rules are ANDed. The player clears the 1200 floor and fails the 1500 cap, and is
    refused — an evaluator that ORed them would admit them on the strength of the rule
    they happen to pass."""
    client, user = entrant_client
    await _rate(db_session, user, default_league, 1650.0)
    event = await _make_event(
        db_session,
        predicates=[
            {"id": "pr-floor", "field": "rating", "op": ">=", "value": 1200},
            {"id": "pr-cap", "field": "rating", "op": "<", "value": 1500},
        ],
    )

    response = await client.post(_entries_url(event))

    assert response.status_code == 409, response.text
    assert response.json()["detail"]["code"] == "rating_ineligible"


async def test_an_event_with_no_rules_admits_a_rated_player(
    entrant_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """The open event: no predicates, so no rule to fail. The guard must not have grown
    an opinion of its own about who may enter an unrestricted event."""
    client, user = entrant_client
    await _rate(db_session, user, default_league, 2400.0)
    event = await _make_event(db_session)

    response = await client.post(_entries_url(event))

    assert response.status_code == 201, response.text


async def test_the_rating_refusal_outranks_the_event_full_refusal(
    entrant_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    player: User,
    default_league: League,
) -> None:
    """An ineligible player entering a *full* event is told about their **rating**, not
    about the capacity.

    Same rule the doubles 400 follows ahead of the status 409: answer with the fact that
    will not change on a retry. "The event is full" invites the player back the moment
    somebody withdraws — and they would be refused again, this time for the reason they
    should have been given now.
    """
    client, user = entrant_client
    await _rate(db_session, user, default_league, 1650.0)
    event = await _make_event(db_session, max_players=1, predicates=CAP_UNDER_1500)
    await _seed_entry(db_session, event, player)

    response = await client.post(_entries_url(event))

    assert response.status_code == 409, response.text
    assert response.json()["detail"]["code"] == "rating_ineligible"


# ----- the director's half of the same endpoint (ADR-0784) --------------------
#
# ``POST …/entries`` takes an OPTIONAL body, and its presence chooses the actor: no
# ``user_id`` is a player self-registering (gated on ``tournament.enter``), a
# ``user_id`` is the tournament's OWNER entering somebody (gated on ownership). Same
# endpoint, deliberately — a twin route would mean the next refusal has to be added
# twice and the two call sites of the eligibility evaluator can drift, which is the
# exact class of bug ADR-0968 exists to delete.
#
# So the load-bearing claims of this section are not really "the director can add a
# player". They are: the director's entry runs through the SAME evaluator, the SAME
# capacity lock and the SAME four refusal codes as a player's — absent a ``force``
# flag (deliberately deferred, #985), that IS the whole safety model — and
# self-registration is byte-for-byte what it was.


@pytest_asyncio.fixture
async def director_client(
    api_client: AsyncClient, db_session: AsyncSession
) -> AsyncIterator[tuple[AsyncClient, User]]:
    """A real session holding **no permissions at all** — its only authority is that
    it OWNS the tournaments the tests below build for it.

    The empty grant is the point. A director entering somebody else is authorized by
    ownership, not by ``tournament.enter``: that permission says "may self-register",
    and refusing an owner for lacking it would be refusing them a grant that has
    nothing to do with what they are doing. If the enter route's permission check were
    still a router dependency — running before the handler has seen the body, and so
    before anything knows which arm of the fork this is — every test in this section
    would 403.
    """
    user = await start_session(api_client, db_session)
    yield api_client, user


async def _entrants_of(client: AsyncClient, event: TournamentEvent) -> list[dict]:
    """The event's entrants as the read path reports them. Needs ``tournament.view``."""
    response = await client.get(f"/v1/tournaments/{event.tournament_id}")
    assert response.status_code == 200, response.text
    (found,) = [e for e in response.json()["events"] if e["id"] == str(event.id)]
    return [dict(entrant) for entrant in found["entrants"]]


async def test_the_owner_enters_another_player_who_appears_as_an_entrant(
    director_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    player: User,
) -> None:
    """**The chore, in one test.** The owner names a ``user_id``; that player is
    entered, is answered as the created entrant, and shows up in the entrants list.

    Two things beyond the 201 are worth naming. The owner holds **no**
    ``tournament.enter`` grant (see ``director_client``) and is admitted anyway —
    ownership is the authorization for this arm. And the row records **who added it**:
    ``added_by_user_id`` is the director, not NULL, because "a director entered them"
    and "they entered themselves" are different facts and the column is where the
    difference lives (ADR-0784).
    """
    client, owner = director_client
    await grant_permissions(db_session, owner, (TOURNAMENT_VIEW,))
    event = await _make_event(db_session, owner=owner)

    response = await client.post(_entries_url(event), json={"user_id": str(player.id)})

    assert response.status_code == 201, response.text
    body = response.json()
    # The 201 describes the row that was written — the PLAYER — not the person who
    # wrote it. A director's POST that answered with the director would be a lie the
    # client would render as an entrant.
    assert body["user_id"] == str(player.id)
    assert body["username"] == player.username

    (row,) = await _active_entries(db_session, event.id)
    assert row.user_id == player.id
    assert row.added_by_user_id == owner.id
    assert body["id"] == str(row.id)

    assert [e["user_id"] for e in await _entrants_of(client, event)] == [str(player.id)]


async def test_a_non_owner_naming_another_players_user_id_is_a_403(
    entrant_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    player: User,
) -> None:
    """A stranger cannot enter somebody else, and holding ``tournament.enter`` does not
    help: that permission is the *self-registration* gate, and this request is not a
    self-registration.

    403, not 409: "you are not the director of this tournament" is a fact about who is
    asking, and it will not change when somebody withdraws. And nothing is written —
    ``_all_entries`` is unfiltered, so a handler that inserted and only then checked
    ownership fails here.
    """
    client, _ = entrant_client
    event = await _make_event(db_session)
    event_id = event.id

    response = await client.post(_entries_url(event), json={"user_id": str(player.id)})

    assert response.status_code == 403, response.text
    assert await _all_entries(db_session, event_id) == []


async def test_the_owner_withdraws_an_entry_that_is_not_their_own(
    director_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    player: User,
) -> None:
    """The withdraw route unifies the same way (ADR-0784): your own entry, **or any
    entry if you own the tournament**.

    The owner holds no ``tournament.enter`` here either — withdrawing a player from a
    tournament you created is a property of ownership. Soft-delete, as always: the row
    survives, ``withdrawn``, and the entrants list drops them.
    """
    client, owner = director_client
    await grant_permissions(db_session, owner, (TOURNAMENT_VIEW,))
    event = await _make_event(db_session, owner=owner)
    entry_id = await _seed_entry(db_session, event, player)

    response = await client.delete(_entry_url(event, entry_id))

    assert response.status_code == 204, response.text
    assert (
        await _reread(db_session, entry_id)
    ).status is TournamentEntryStatus.withdrawn
    assert await _entrants_of(client, event) == []


async def test_the_owner_entering_themselves_by_user_id_records_no_adder(
    director_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """The degenerate self-add, **normalised**: an owner who names their OWN ``user_id``
    is self-registering, and self-registration is spelled ``added_by_user_id = NULL``.

    Writing ``added_by == user_id`` instead would be a second, contradictory encoding of
    "the player entered themselves" — one the entrants list would render as "added by
    the director" on an entry whose director *is* the player. ``merge_user`` already
    collapses that shape when a merge would otherwise produce it; the route must not
    mint it in the first place.

    It follows that the owner needs ``tournament.enter`` here — because this *is* the
    self-registration path, not a director entry. Same guard, same row, whether the body
    is absent or names you.
    """
    client, owner = director_client
    await grant_permissions(db_session, owner, (TOURNAMENT_ENTER,))
    event = await _make_event(db_session, owner=owner)

    response = await client.post(_entries_url(event), json={"user_id": str(owner.id)})

    assert response.status_code == 201, response.text
    (row,) = await _active_entries(db_session, event.id)
    assert row.user_id == owner.id
    assert row.added_by_user_id is None, (
        "an owner entering themselves IS self-registration — it must not be stored as "
        "added_by == user_id, a second encoding of the same fact"
    )


async def test_naming_your_own_user_id_is_self_registration_for_a_non_owner_too(
    entrant_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    event: TournamentEvent,
) -> None:
    """The fork turns on WHO is named, not on who owns the tournament: a plain player
    who spells out their own ``user_id`` is self-registering — 201 on the strength of
    ``tournament.enter``, with no adder recorded — and is emphatically not refused by
    the director arm's ownership check.

    The identity test is what makes ``added_by == user_id`` unrepresentable *by any
    caller*, not merely by the owner."""
    client, user = entrant_client

    response = await client.post(_entries_url(event), json={"user_id": str(user.id)})

    assert response.status_code == 201, response.text
    (row,) = await _active_entries(db_session, event.id)
    assert (row.user_id, row.added_by_user_id) == (user.id, None)


async def test_the_owner_still_needs_the_enter_permission_to_enter_themselves(
    director_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """The self-registration gate is intact, and owning the tournament does not
    substitute for it: an owner with no ``tournament.enter`` who POSTs with **no body**
    is refused exactly as any other player would be.

    This is the test that catches the tempting simplification — "the owner may do
    anything to their own tournament" — which would quietly hand the director an
    entry path that skips the permission every other self-registration goes through.
    """
    client, owner = director_client
    event = await _make_event(db_session, owner=owner)
    event_id = event.id

    response = await client.post(_entries_url(event))

    assert response.status_code == 403, response.text
    assert await _all_entries(db_session, event_id) == []


async def test_a_directors_entry_into_a_full_event_is_refused_with_event_full(
    director_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    player: User,
) -> None:
    """**No ``force``, and this is what that means** (ADR-0784): a director adding a
    player to an event that already holds ``max_players`` is refused with the *same*
    ``event_full`` code the player would have got, and no row is written.

    Absent an override flag, running the director through the same guards IS the entire
    safety model. A route that skipped capacity "because the director knows best" would
    overfill the field the draw is cut from — silently, and only for the one caller
    whose mistakes nobody else can catch.
    """
    client, owner = director_client
    event = await _make_event(db_session, owner=owner, max_players=1)
    event_id = event.id
    sitting = await make_user(db_session, f"sitting-{uuid.uuid4().hex[:8]}")
    await _seed_entry(db_session, event, sitting)

    response = await client.post(_entries_url(event), json={"user_id": str(player.id)})

    assert response.status_code == 409, response.text
    assert response.json()["detail"]["code"] == "event_full"
    assert len(await _all_entries(db_session, event_id)) == 1


async def test_a_directors_entry_over_the_rating_cap_is_rating_ineligible(
    director_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    player: User,
    default_league: League,
) -> None:
    """The other half of "no ``force``": the event's rating rules judge the player being
    ENTERED, and a director adding a 1650 player to the "Under 1500" event is refused
    with the same ``rating_ineligible`` code.

    The director themselves is unrated — so a handler that judged the *caller's* rating
    (the obvious copy-paste of the self-registration line) would sail through, because
    an unrated player passes every rule (ADR-0783 §3). That is the bug this test is
    shaped to catch: eligibility as an accidental function of who is holding the phone.
    """
    client, owner = director_client
    await _rate(db_session, player, default_league, 1650.0)
    event = await _make_event(db_session, owner=owner, predicates=CAP_UNDER_1500)
    event_id = event.id

    response = await client.post(_entries_url(event), json={"user_id": str(player.id)})

    assert response.status_code == 409, response.text
    assert response.json()["detail"]["code"] == "rating_ineligible"
    assert await _all_entries(db_session, event_id) == []


@pytest.mark.parametrize(
    "tournament_status",
    [TournamentStatus.draft, TournamentStatus.live, TournamentStatus.archived],
)
async def test_a_director_obeys_the_registration_window_a_player_obeys(
    director_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    player: User,
    tournament_status: TournamentStatus,
) -> None:
    """The director gets no window of their own: the tournament's status is the
    registration window (ADR-0017) for them too, so adding a player outside
    ``published`` is the same ``registration_closed`` 409.

    ``live`` is the case with teeth, and it is **deliberate rather than an oversight**:
    it means #784 does not solve walk-ins. The override that would — and the no-show
    withdrawal beside it — is one coherent ticket (#985), not a flag smuggled in here.
    """
    client, owner = director_client
    event = await _make_event(db_session, owner=owner, status=tournament_status)
    event_id = event.id

    response = await client.post(_entries_url(event), json={"user_id": str(player.id)})

    assert response.status_code == 409, response.text
    assert response.json()["detail"]["code"] == "registration_closed"
    assert await _all_entries(db_session, event_id) == []


async def test_the_owner_cannot_withdraw_an_entry_once_the_tournament_is_live(
    director_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    player: User,
) -> None:
    """Withdrawal stays **symmetric** with entry: the owner obeys the same window, so a
    no-show cannot be removed from a live tournament either.

    The asymmetric alternative — the owner may withdraw at any time, but only add during
    registration — is the more useful product and was still rejected: it is an override
    leaking back in through the withdraw door, with different rules and no flag to name
    it (ADR-0784). 409, and the entry is untouched.
    """
    client, owner = director_client
    event = await _make_event(db_session, owner=owner, status=TournamentStatus.live)
    entry_id = await _seed_entry(db_session, event, player)

    response = await client.delete(_entry_url(event, entry_id))

    assert response.status_code == 409, response.text
    assert (await _reread(db_session, entry_id)).status is TournamentEntryStatus.entered


async def test_entering_a_user_id_that_names_nobody_is_a_404(
    director_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """A well-formed id that names no player: a 404 about the *player*, not a 500 from
    the FK, and not a 422 (the request's shape is fine — it is the world that has no
    such user)."""
    client, owner = director_client
    event = await _make_event(db_session, owner=owner)
    event_id = event.id

    response = await client.post(
        _entries_url(event), json={"user_id": str(uuid.uuid4())}
    )

    assert response.status_code == 404, response.text
    assert await _all_entries(db_session, event_id) == []


async def test_a_tombstoned_user_cannot_be_entered(
    director_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    player: User,
) -> None:
    """A merged-away guest is a ghost — no listing, search or auth query will ever
    return them — so entering one would seed the draw with a player who cannot sign in,
    be notified, or turn up. The lookup excludes them exactly as ``/v1/players/search``
    does, and the refusal is the same 404 as an id that names nobody: as far as this
    endpoint is concerned, nobody is who they name."""
    client, owner = director_client
    survivor = await make_user(db_session, f"survivor-{uuid.uuid4().hex[:8]}")
    player.merged_into_user_id = survivor.id
    await db_session.commit()
    event = await _make_event(db_session, owner=owner)
    event_id, ghost_id = event.id, player.id

    response = await client.post(_entries_url(event), json={"user_id": str(ghost_id)})

    assert response.status_code == 404, response.text
    assert await _all_entries(db_session, event_id) == []


async def test_a_director_entering_the_same_player_twice_is_already_entered(
    director_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    player: User,
) -> None:
    """The duplicate guard is the same partial unique index, reached through the same
    caught ``IntegrityError``: the director's second attempt is an ``already_entered``
    409, not a 500 and not a second row.

    It is also why ``added_by_user_id`` deliberately carries **no** CHECK constraint
    (ADR-0784): a constraint violation on this INSERT would be caught here and reported
    as "you have already entered this event" — a refusal that would be simply false.
    """
    client, owner = director_client
    event = await _make_event(db_session, owner=owner)
    url, event_id = _entries_url(event), event.id
    body = {"user_id": str(player.id)}

    assert (await client.post(url, json=body)).status_code == 201

    duplicate = await client.post(url, json=body)

    assert duplicate.status_code == 409, duplicate.text
    assert duplicate.json()["detail"]["code"] == "already_entered"
    assert len(await _active_entries(db_session, event_id)) == 1


async def test_an_unknown_field_in_the_entry_body_is_a_422(
    director_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    player: User,
) -> None:
    """``extra="forbid"`` on the request model, and the one worth naming: ``force``.

    A client that sends ``{"user_id": …, "force": true}`` expecting the override to
    exist gets a 422, not a silently-ignored flag and an entry that was quietly judged
    by the rules it thought it was bypassing. The override is #985's to design; until
    then, the honest answer to a request for it is "no such field".
    """
    client, owner = director_client
    event = await _make_event(db_session, owner=owner)
    event_id = event.id

    response = await client.post(
        _entries_url(event), json={"user_id": str(player.id), "force": True}
    )

    assert response.status_code == 422, response.text
    assert await _all_entries(db_session, event_id) == []


# ===== the transport-neutral enter_event verb =================================
#
# These drive ``app.tournament_entries.enter_event`` directly with a raw
# ``db_session`` and no FastAPI — the branch matrix behind the HTTP endpoint tests
# above (which pin the wire contract and stay green untouched). They prove each arm of
# the dual-actor fork (ADR-0784), the ordered refusals and the four machine-readable
# codes (ADR-0968) are signalled as **domain exceptions** from ``app.tournament_errors``
# — never an ``HTTPException`` — which is what lets the MCP tool reuse the same verb.


async def _grant_enter(db_session: AsyncSession, user: User) -> None:
    """Give ``user`` a real ``tournament.enter`` grant through RBAC rows, so the verb's
    self-path permission gate (the one query ``_require_enter_permission`` runs) is
    exercised, not stubbed."""
    await grant_permissions(db_session, user, (TOURNAMENT_ENTER,))


async def test_verb_self_registration_succeeds_and_records_no_adder(
    db_session: AsyncSession,
) -> None:
    """The self path: an actor holding ``tournament.enter`` enters themselves, the verb
    returns the entrant, and the row records NULL as the adder (ADR-0784)."""
    actor = await make_user(db_session, f"self-{uuid.uuid4().hex[:8]}")
    await _grant_enter(db_session, actor)
    event = await _make_event(db_session)

    entrant = await enter_event_verb(
        db_session,
        tournament_id=event.tournament_id,
        event_id=event.id,
        actor=actor,
        user_id=None,
    )

    assert entrant.user_id == actor.id
    assert entrant.username == actor.username
    (row,) = await _active_entries(db_session, event.id)
    assert row.user_id == actor.id
    assert row.added_by_user_id is None


async def test_verb_naming_your_own_id_is_self_registration(
    db_session: AsyncSession,
) -> None:
    """Naming your OWN ``user_id`` is self-registration, not a director entry: same
    permission gate, and ``added_by_user_id`` stays NULL — the one encoding of "the
    player entered themselves"."""
    actor = await make_user(db_session, f"selfid-{uuid.uuid4().hex[:8]}")
    await _grant_enter(db_session, actor)
    event = await _make_event(db_session)

    await enter_event_verb(
        db_session,
        tournament_id=event.tournament_id,
        event_id=event.id,
        actor=actor,
        user_id=actor.id,
    )

    (row,) = await _active_entries(db_session, event.id)
    assert (row.user_id, row.added_by_user_id) == (actor.id, None)


async def test_verb_self_registration_without_the_permission_is_refused(
    db_session: AsyncSession,
) -> None:
    """The self path is gated on ``tournament.enter``: an actor without it raises
    :class:`NotAllowedToEnterError`, before the tournament is even loaded, and nothing
    is
    written."""
    actor = await make_user(db_session, f"noperm-{uuid.uuid4().hex[:8]}")
    event = await _make_event(db_session)
    event_id = event.id

    with pytest.raises(NotAllowedToEnterError):
        await enter_event_verb(
            db_session,
            tournament_id=event.tournament_id,
            event_id=event_id,
            actor=actor,
            user_id=None,
        )
    assert await _all_entries(db_session, event_id) == []


async def test_verb_owner_enters_another_player_recording_the_adder(
    db_session: AsyncSession,
) -> None:
    """The director path: the owner names another player's id and enters them —
    ownership is the authorization (no ``tournament.enter`` grant), and the row records
    the owner as the adder (ADR-0784)."""
    owner = await make_user(db_session, f"owner-{uuid.uuid4().hex[:8]}")
    player = await make_user(db_session, f"player-{uuid.uuid4().hex[:8]}")
    event = await _make_event(db_session, owner=owner)

    entrant = await enter_event_verb(
        db_session,
        tournament_id=event.tournament_id,
        event_id=event.id,
        actor=owner,
        user_id=player.id,
    )

    # The created row describes the PLAYER, not the director who wrote it.
    assert entrant.user_id == player.id
    assert entrant.username == player.username
    (row,) = await _active_entries(db_session, event.id)
    assert (row.user_id, row.added_by_user_id) == (player.id, owner.id)


async def test_verb_non_owner_naming_another_player_is_not_owner_error(
    db_session: AsyncSession,
) -> None:
    """A non-owner naming somebody else's id is the director arm, gated on ownership:
    :class:`NotTournamentOwnerError`, even holding ``tournament.enter`` (that permission
    is the self-registration gate, and this is not a self-registration). Nothing
    written."""
    stranger = await make_user(db_session, f"stranger-{uuid.uuid4().hex[:8]}")
    await _grant_enter(db_session, stranger)  # the self gate must not admit this arm
    other = await make_user(db_session, f"other-{uuid.uuid4().hex[:8]}")
    event = await _make_event(db_session)  # owned by a throwaway director, not stranger
    event_id = event.id

    with pytest.raises(NotTournamentOwnerError):
        await enter_event_verb(
            db_session,
            tournament_id=event.tournament_id,
            event_id=event_id,
            actor=stranger,
            user_id=other.id,
        )
    assert await _all_entries(db_session, event_id) == []


async def test_verb_director_naming_an_unknown_user_is_player_not_found(
    db_session: AsyncSession,
) -> None:
    """The owner names a ``user_id`` that resolves to no enterable player:
    :class:`PlayerNotFoundError` (a not-found, judged after the ownership gate). Nothing
    written."""
    owner = await make_user(db_session, f"owner-{uuid.uuid4().hex[:8]}")
    event = await _make_event(db_session, owner=owner)
    event_id = event.id

    with pytest.raises(PlayerNotFoundError):
        await enter_event_verb(
            db_session,
            tournament_id=event.tournament_id,
            event_id=event_id,
            actor=owner,
            user_id=uuid.uuid4(),
        )
    assert await _all_entries(db_session, event_id) == []


async def test_verb_missing_tournament_is_tournament_not_found(
    db_session: AsyncSession,
) -> None:
    """An absent tournament id raises :class:`TournamentNotFoundError` (the self gate
    has
    already passed; the load is what refuses)."""
    actor = await make_user(db_session, f"self-{uuid.uuid4().hex[:8]}")
    await _grant_enter(db_session, actor)

    with pytest.raises(TournamentNotFoundError):
        await enter_event_verb(
            db_session,
            tournament_id=uuid.uuid4(),
            event_id=uuid.uuid4(),
            actor=actor,
            user_id=None,
        )


async def test_verb_missing_event_under_a_real_tournament_is_event_not_found(
    db_session: AsyncSession,
) -> None:
    """A real tournament but an event id that names nothing under it raises
    :class:`EventNotFoundError`."""
    actor = await make_user(db_session, f"self-{uuid.uuid4().hex[:8]}")
    await _grant_enter(db_session, actor)
    event = await _make_event(db_session)

    with pytest.raises(EventNotFoundError):
        await enter_event_verb(
            db_session,
            tournament_id=event.tournament_id,
            event_id=uuid.uuid4(),
            actor=actor,
            user_id=None,
        )


async def test_verb_a_doubles_event_is_non_singles_entry(
    db_session: AsyncSession,
) -> None:
    """A doubles event cannot be entered directly (ADR-0016):
    :class:`NonSinglesEntryError`,
    carrying the format for the 400 body, judged after the self gate and the load.
    Nothing
    written."""
    actor = await make_user(db_session, f"self-{uuid.uuid4().hex[:8]}")
    await _grant_enter(db_session, actor)
    event = await _make_event(db_session, format=EventFormat.doubles)
    event_id = event.id

    with pytest.raises(NonSinglesEntryError) as exc_info:
        await enter_event_verb(
            db_session,
            tournament_id=event.tournament_id,
            event_id=event_id,
            actor=actor,
            user_id=None,
        )
    assert exc_info.value.event_format == EventFormat.doubles.value
    assert await _all_entries(db_session, event_id) == []


async def test_verb_registration_closed_fires_with_its_code(
    db_session: AsyncSession,
) -> None:
    """Entering an event of a non-``published`` tournament raises
    :class:`EntryRefusedError` carrying the ``registration_closed`` code (ADR-0968)."""
    actor = await make_user(db_session, f"self-{uuid.uuid4().hex[:8]}")
    await _grant_enter(db_session, actor)
    event = await _make_event(db_session, status=TournamentStatus.draft)
    event_id = event.id

    with pytest.raises(EntryRefusedError) as exc_info:
        await enter_event_verb(
            db_session,
            tournament_id=event.tournament_id,
            event_id=event_id,
            actor=actor,
            user_id=None,
        )
    assert exc_info.value.refusal is EntryRefusal.registration_closed
    assert await _all_entries(db_session, event_id) == []


async def test_verb_rating_ineligible_fires_with_its_code(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """A player over the event's rating cap raises :class:`EntryRefusedError` carrying
    the
    ``rating_ineligible`` code, and the rating it was judged on comes back in the
    message
    (ADR-0783 / ADR-0968). Nothing written."""
    actor = await make_user(db_session, f"self-{uuid.uuid4().hex[:8]}")
    await _grant_enter(db_session, actor)
    await rate_player(db_session, actor, default_league, 1650.0)
    event = await _make_event(db_session, predicates=CAP_UNDER_1500)
    event_id = event.id

    with pytest.raises(EntryRefusedError) as exc_info:
        await enter_event_verb(
            db_session,
            tournament_id=event.tournament_id,
            event_id=event_id,
            actor=actor,
            user_id=None,
        )
    assert exc_info.value.refusal is EntryRefusal.rating_ineligible
    assert str(exc_info.value), "the refusal carries a fallback message"
    assert await _all_entries(db_session, event_id) == []


async def test_verb_event_full_fires_with_its_code(
    db_session: AsyncSession,
) -> None:
    """An event already at ``max_players`` active entrants raises
    :class:`EntryRefusedError` carrying the ``event_full`` code — counted under the
    tournament row lock. The seeded entrant survives; nothing new is written."""
    actor = await make_user(db_session, f"self-{uuid.uuid4().hex[:8]}")
    await _grant_enter(db_session, actor)
    other = await make_user(db_session, f"other-{uuid.uuid4().hex[:8]}")
    event = await _make_event(db_session, max_players=1)
    db_session.add(TournamentEntry(event_id=event.id, user_id=other.id))
    await db_session.commit()
    event_id = event.id

    with pytest.raises(EntryRefusedError) as exc_info:
        await enter_event_verb(
            db_session,
            tournament_id=event.tournament_id,
            event_id=event_id,
            actor=actor,
            user_id=None,
        )
    assert exc_info.value.refusal is EntryRefusal.event_full
    assert [e.user_id for e in await _active_entries(db_session, event_id)] == [
        other.id
    ]


async def test_verb_already_entered_fires_with_its_code(
    db_session: AsyncSession,
) -> None:
    """A second active entry for the same player raises :class:`EntryRefusedError`
    carrying the ``already_entered`` code — the partial unique index's
    ``IntegrityError``,
    caught at commit. The one existing active entry remains."""
    actor = await make_user(db_session, f"self-{uuid.uuid4().hex[:8]}")
    await _grant_enter(db_session, actor)
    event = await _make_event(db_session)
    db_session.add(TournamentEntry(event_id=event.id, user_id=actor.id))
    await db_session.commit()
    event_id = event.id

    with pytest.raises(EntryRefusedError) as exc_info:
        await enter_event_verb(
            db_session,
            tournament_id=event.tournament_id,
            event_id=event_id,
            actor=actor,
            user_id=None,
        )
    assert exc_info.value.refusal is EntryRefusal.already_entered
    assert len(await _active_entries(db_session, event_id)) == 1


async def test_verb_a_director_adding_an_over_rated_player_is_rating_ineligible(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """**The safety model, in one test (ADR-0784).** A director's entry is judged by the
    SAME eligibility as a player's: the owner (holding no ``tournament.enter`` grant,
    and
    themselves unrated) adds a 1650-rated player to an "Under 1500" event, and it is
    refused ``rating_ineligible`` — the PLAYER's rating is judged, not the director's,
    so
    ownership is never an eligibility bypass. Nothing written."""
    owner = await make_user(db_session, f"owner-{uuid.uuid4().hex[:8]}")
    player = await make_user(db_session, f"player-{uuid.uuid4().hex[:8]}")
    await rate_player(db_session, player, default_league, 1650.0)
    event = await _make_event(db_session, predicates=CAP_UNDER_1500, owner=owner)
    event_id = event.id

    with pytest.raises(EntryRefusedError) as exc_info:
        await enter_event_verb(
            db_session,
            tournament_id=event.tournament_id,
            event_id=event_id,
            actor=owner,
            user_id=player.id,
        )
    assert exc_info.value.refusal is EntryRefusal.rating_ineligible
    assert await _all_entries(db_session, event_id) == []


# ----- the withdraw_from_event VERB (chore 3b) -------------------------------
#
# The transport-neutral withdraw verb, driven directly with a raw session — no HTTP,
# no MCP — so the owner-or-self fork (ADR-0784), the soft-delete, the load/refusal
# ordering and the re-enterability the partial unique index buys are asserted where
# they live, once, for both adapters. The HTTP endpoint tests above stay untouched.


async def test_withdraw_verb_entrant_withdraws_their_own_entry(
    db_session: AsyncSession,
) -> None:
    """The self path: an entrant holding ``tournament.enter`` withdraws their OWN entry.
    The status flips to ``withdrawn`` and the ROW SURVIVES (a soft delete, ADR-0784), so
    the event keeps its withdrawal history and no active entry remains."""
    entrant = await make_user(db_session, f"self-{uuid.uuid4().hex[:8]}")
    await _grant_enter(db_session, entrant)
    event = await _make_event(db_session)
    entry_id = await _seed_entry(db_session, event, entrant)
    event_id = event.id

    await withdraw_from_event_verb(
        db_session,
        tournament_id=event.tournament_id,
        event_id=event_id,
        entry_id=entry_id,
        actor=entrant,
    )

    # The row is still there, flipped — not gone.
    row = await _reread(db_session, entry_id)
    assert row.status is TournamentEntryStatus.withdrawn
    assert await _active_entries(db_session, event_id) == []
    # And the soft delete is total: exactly one row, the withdrawn one.
    assert [e.id for e in await _all_entries(db_session, event_id)] == [entry_id]


async def test_withdraw_verb_owner_withdraws_another_players_entry(
    db_session: AsyncSession,
) -> None:
    """The owner path: the tournament's creator withdraws SOMEBODY ELSE's entry, holding
    NO ``tournament.enter`` grant — managing the field of a tournament you created is a
    property of ownership, not a role grant (ADR-0784). The entry is soft-deleted."""
    owner = await make_user(db_session, f"owner-{uuid.uuid4().hex[:8]}")
    player = await make_user(db_session, f"player-{uuid.uuid4().hex[:8]}")
    event = await _make_event(db_session, owner=owner)
    entry_id = await _seed_entry(db_session, event, player)
    event_id = event.id

    await withdraw_from_event_verb(
        db_session,
        tournament_id=event.tournament_id,
        event_id=event_id,
        entry_id=entry_id,
        actor=owner,
    )

    assert (await _reread(db_session, entry_id)).status is (
        TournamentEntryStatus.withdrawn
    )
    assert await _active_entries(db_session, event_id) == []


async def test_withdraw_verb_a_third_party_is_not_allowed_to_withdraw(
    db_session: AsyncSession,
) -> None:
    """A caller who is NEITHER the entry's own player NOR the tournament's owner raises
    :class:`NotAllowedToWithdrawError`, even holding ``tournament.enter`` (that grant is
    the SELF gate, and this is not their entry). The entry stays active — nothing
    changed."""
    entrant = await make_user(db_session, f"entrant-{uuid.uuid4().hex[:8]}")
    stranger = await make_user(db_session, f"stranger-{uuid.uuid4().hex[:8]}")
    await _grant_enter(db_session, stranger)  # the self gate must not admit this arm
    event = await _make_event(db_session)  # owned by a throwaway director, not stranger
    entry_id = await _seed_entry(db_session, event, entrant)

    with pytest.raises(NotAllowedToWithdrawError):
        await withdraw_from_event_verb(
            db_session,
            tournament_id=event.tournament_id,
            event_id=event.id,
            entry_id=entry_id,
            actor=stranger,
        )
    assert (await _reread(db_session, entry_id)).status is (
        TournamentEntryStatus.entered
    )


async def test_withdraw_verb_self_withdrawer_without_the_permission_is_refused(
    db_session: AsyncSession,
) -> None:
    """The self path is gated on ``tournament.enter`` exactly as self-registration is:
    an entrant WITHOUT it withdrawing their own entry raises
    :class:`NotAllowedToEnterError` (the one shared self-action gate), and the entry
    stays active."""
    entrant = await make_user(db_session, f"noperm-{uuid.uuid4().hex[:8]}")
    event = await _make_event(db_session)
    entry_id = await _seed_entry(db_session, event, entrant)

    with pytest.raises(NotAllowedToEnterError):
        await withdraw_from_event_verb(
            db_session,
            tournament_id=event.tournament_id,
            event_id=event.id,
            entry_id=entry_id,
            actor=entrant,
        )
    assert (await _reread(db_session, entry_id)).status is (
        TournamentEntryStatus.entered
    )


async def test_withdraw_verb_missing_tournament_is_tournament_not_found(
    db_session: AsyncSession,
) -> None:
    """An absent tournament id raises :class:`TournamentNotFoundError` — the locked load
    is what refuses, before the fork is reached."""
    actor = await make_user(db_session, f"self-{uuid.uuid4().hex[:8]}")
    await _grant_enter(db_session, actor)

    with pytest.raises(TournamentNotFoundError):
        await withdraw_from_event_verb(
            db_session,
            tournament_id=uuid.uuid4(),
            event_id=uuid.uuid4(),
            entry_id=uuid.uuid4(),
            actor=actor,
        )


async def test_withdraw_verb_missing_event_is_event_not_found(
    db_session: AsyncSession,
) -> None:
    """A real tournament but an event id that names nothing under it raises
    :class:`EventNotFoundError`, before the entry is looked up."""
    actor = await make_user(db_session, f"self-{uuid.uuid4().hex[:8]}")
    await _grant_enter(db_session, actor)
    event = await _make_event(db_session)

    with pytest.raises(EventNotFoundError):
        await withdraw_from_event_verb(
            db_session,
            tournament_id=event.tournament_id,
            event_id=uuid.uuid4(),
            entry_id=uuid.uuid4(),
            actor=actor,
        )


async def test_withdraw_verb_missing_entry_is_entry_not_found(
    db_session: AsyncSession,
) -> None:
    """A real tournament and event but an entry id that names nothing under the event
    raises :class:`EntryNotFoundError` — the last of the three 404s, judged before any
    403."""
    actor = await make_user(db_session, f"self-{uuid.uuid4().hex[:8]}")
    await _grant_enter(db_session, actor)
    event = await _make_event(db_session)

    with pytest.raises(EntryNotFoundError):
        await withdraw_from_event_verb(
            db_session,
            tournament_id=event.tournament_id,
            event_id=event.id,
            entry_id=uuid.uuid4(),
            actor=actor,
        )


async def test_withdraw_verb_an_entry_under_a_different_event_is_entry_not_found(
    db_session: AsyncSession,
) -> None:
    """An entry that exists but hangs off a DIFFERENT event is not addressable through
    this (tournament, event) pair: :class:`EntryNotFoundError`, not a cross-event
    withdrawal. The entry the caller didn't name stays active."""
    owner = await make_user(db_session, f"owner-{uuid.uuid4().hex[:8]}")
    entrant = await make_user(db_session, f"entrant-{uuid.uuid4().hex[:8]}")
    named = await _make_event(db_session, owner=owner)
    other = await _make_event(db_session, owner=owner)
    other_entry_id = await _seed_entry(db_session, other, entrant)

    with pytest.raises(EntryNotFoundError):
        await withdraw_from_event_verb(
            db_session,
            tournament_id=named.tournament_id,
            event_id=named.id,
            entry_id=other_entry_id,
            actor=owner,
        )
    assert (await _reread(db_session, other_entry_id)).status is (
        TournamentEntryStatus.entered
    )


async def test_withdraw_verb_an_active_entry_outside_the_window_is_registration_closed(
    db_session: AsyncSession,
) -> None:
    """Withdrawing an ACTIVE entry while registration is shut (a ``draft`` tournament)
    raises :class:`WithdrawalRegistrationClosedError` carrying the bare-prose sentence —
    NOT the coded ``EntryRefusedError`` the enter leg raises (ADR-0968 keeps the code to
    the entry endpoint). The entry stays active."""
    entrant = await make_user(db_session, f"self-{uuid.uuid4().hex[:8]}")
    await _grant_enter(db_session, entrant)
    event = await _make_event(db_session, status=TournamentStatus.draft)
    entry_id = await _seed_entry(db_session, event, entrant)

    with pytest.raises(WithdrawalRegistrationClosedError) as exc_info:
        await withdraw_from_event_verb(
            db_session,
            tournament_id=event.tournament_id,
            event_id=event.id,
            entry_id=entry_id,
            actor=entrant,
        )
    assert str(exc_info.value), "the refusal carries the domain-authored sentence"
    assert (await _reread(db_session, entry_id)).status is (
        TournamentEntryStatus.entered
    )


async def test_withdraw_verb_an_already_withdrawn_entry_is_an_idempotent_no_op(
    db_session: AsyncSession,
) -> None:
    """An entry that is ALREADY withdrawn has nothing left to lock, so the verb succeeds
    in a non-``published`` status (here ``live``) rather than refusing — the idempotent
    204 ADR-0016 designed. The row stays ``withdrawn``."""
    entrant = await make_user(db_session, f"self-{uuid.uuid4().hex[:8]}")
    await _grant_enter(db_session, entrant)
    event = await _make_event(db_session, status=TournamentStatus.live)
    entry_id = await _seed_entry(
        db_session, event, entrant, status=TournamentEntryStatus.withdrawn
    )

    await withdraw_from_event_verb(
        db_session,
        tournament_id=event.tournament_id,
        event_id=event.id,
        entry_id=entry_id,
        actor=entrant,
    )

    assert (await _reread(db_session, entry_id)).status is (
        TournamentEntryStatus.withdrawn
    )


async def test_withdraw_verb_frees_the_player_to_enter_the_same_event_again(
    db_session: AsyncSession,
) -> None:
    """The partial unique index is over ACTIVE entries only, so once the verb has
    withdrawn a player's entry they may enter the same event again cleanly — the
    withdrawn row and a fresh active row coexist for the same (event, player)."""
    entrant = await make_user(db_session, f"self-{uuid.uuid4().hex[:8]}")
    await _grant_enter(db_session, entrant)
    event = await _make_event(db_session)
    entry_id = await _seed_entry(db_session, event, entrant)
    event_id = event.id

    await withdraw_from_event_verb(
        db_session,
        tournament_id=event.tournament_id,
        event_id=event_id,
        entry_id=entry_id,
        actor=entrant,
    )
    # Re-entering the same event now that the prior entry is withdrawn.
    entrant_read = await enter_event_verb(
        db_session,
        tournament_id=event.tournament_id,
        event_id=event_id,
        actor=entrant,
        user_id=None,
    )

    assert entrant_read.user_id == entrant.id
    # Exactly one ACTIVE entry (the new one), and the withdrawn row still on file.
    active = await _active_entries(db_session, event_id)
    assert [e.user_id for e in active] == [entrant.id]
    assert active[0].id != entry_id
    assert len(await _all_entries(db_session, event_id)) == 2

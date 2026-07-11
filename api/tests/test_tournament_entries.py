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

import uuid
from collections.abc import AsyncIterator
from decimal import Decimal

import pytest
import pytest_asyncio
from httpx import AsyncClient
from sqlalchemy import delete, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    DrawType,
    EventFormat,
    Tournament,
    TournamentEntry,
    TournamentEntryStatus,
    TournamentEvent,
    User,
)
from app.tournaments import TOURNAMENT_ENTER, TOURNAMENT_VIEW
from tests._helpers import grant_permissions, make_client, make_user, start_session

ACTIVE_ENTRY_INDEX = "uq_tournament_entries_event_id_user_id_active"


async def _make_event(
    db_session: AsyncSession, format: EventFormat = EventFormat.singles
) -> TournamentEvent:
    """An event of ``format`` under a tournament owned by its own throwaway
    director. Written straight to the database rather than through the create
    routes: those are owner-only and permission-gated, and dragging that setup in
    would blur which grant the entry route is actually being tested against.

    The JSONB value-objects carry *valid* payloads rather than partial dicts — the
    read path validates them into ``Address``/``Slot``/``MatchSettings`` on the way
    out, so a partial one would 500 any test that reads this tournament back
    through ``GET /v1/tournaments/{id}`` (as the withdrawal-count test does).
    """
    director = await make_user(db_session, f"director-{uuid.uuid4().hex[:8]}")
    tournament = Tournament(
        name="Spring Open",
        address={
            "venue": "Berkeley TT Club",
            "street": "1 Shattuck Ave",
            "city": "Berkeley",
            "region": "CA",
            "postal": "94704",
            "country": "USA",
        },
        created_by_user_id=director.id,
    )
    db_session.add(tournament)
    await db_session.flush()

    event = TournamentEvent(
        tournament_id=tournament.id,
        name="Open Singles",
        format=format,
        draw_type=DrawType.single_elim,
        max_players=64,
        entry_fee=Decimal("20.00"),
        slot={"date": "2026-08-01", "start": "09:00", "end": "17:00"},
        match_settings={"rated": True, "length_games": 5},
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
    return await make_user(db_session, f"player-{uuid.uuid4().hex[:8]}")


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
    # The response addresses the row it created: ``id`` is the *entry's* id, which
    # is what a client will withdraw through (``DELETE …/entries/{entry_id}``).
    assert body["id"] == str(row.id)


async def test_entering_the_same_event_twice_is_a_409(
    entrant_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    event: TournamentEvent,
) -> None:
    """Not a 500 (an uncaught IntegrityError), and not a second row."""
    client, _ = entrant_client
    # The 409 path rolls the shared session back, which expires the ORM instances
    # — read the ids out as plain values first.
    url, event_id = _entries_url(event), event.id

    assert (await client.post(url)).status_code == 201

    duplicate = await client.post(url)

    assert duplicate.status_code == 409, duplicate.text
    assert duplicate.json()["detail"] == "You have already entered this event."
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

"""An event's draw configuration is a row, and the row is what the database
constrains (ADR "an event's draw configuration is a row, not a column").

Three claims, and they are separate ones:

* **Creating an event creates exactly one settings row carrying that event's draw
  type** — driven through the real HTTP route, not the service verb, because the
  ``NOT NULL`` FK has to hold for the path a director actually takes.
* **A settings row cannot name a draw type that has no seeded row.** That is the
  FK to ``draw_types.key`` doing the work, and it is only evidence if something
  tries to violate it — so this file inserts an unseeded slug with raw SQL and
  asserts the database refuses it. Without that test the constraint is decoration.
* **A deleted event, and a deleted tournament, leave no settings row behind.**
  Nothing in the database can do this: the FK points from the event AT the
  settings row, so a settings row has nothing to cascade along and Postgres would
  keep it forever. The two paths are cleaned up by different mechanisms and so are
  tested separately — the event path by the ORM's ``delete-orphan`` on
  ``TournamentEvent.draw_settings``, the tournament path by an explicit reap in
  ``delete_tournament``, because the tournament's ``ON DELETE CASCADE`` sweeps its
  events in the DATABASE and a database cascade cannot run a Python-side one.

The draw type has exactly one home — ``tournament_event_draw_settings.draw_type_key``
— so these tests read it from there and nowhere else. There is no ``draw_type``
column on ``tournament_events`` to cross-check it against, which is the point.
"""

import uuid
from collections.abc import AsyncIterator
from typing import Any

import pytest
import pytest_asyncio
import sqlalchemy as sa
from httpx import AsyncClient
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    DrawType,
    TournamentEvent,
    TournamentEventDrawSettings,
    User,
)
from app.tournaments import TOURNAMENT_CREATE, TOURNAMENT_VIEW
from tests._helpers import grant_permissions, start_session


@pytest_asyncio.fixture
async def authed_client(
    api_client: AsyncClient, db_session: AsyncSession
) -> AsyncIterator[tuple[AsyncClient, User]]:
    """The shared ``api_client`` with a real session whose user holds
    ``tournament.view`` + ``tournament.create`` — the same genuine RBAC rows
    ``test_tournaments`` grants, not a dependency override."""
    user = await start_session(api_client, db_session)
    await grant_permissions(db_session, user, (TOURNAMENT_VIEW, TOURNAMENT_CREATE))
    yield api_client, user


def _tournament_payload() -> dict[str, Any]:
    return {
        "name": "Draw Settings Cup",
        "address": {
            "venue": "Berkeley TT Club",
            "street": "2727 Milvia St",
            "city": "Berkeley",
            "region": "CA",
            "postal": "94703",
            "country": "USA",
        },
        "table_catalogue": [{"id": "t1", "label": "Table 1", "court": "A"}],
    }


def _event_payload(**overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "name": "Open Singles",
        "format": "singles",
        "draw_type": "round-robin",
        "max_players": 64,
        "entry_fee": 45,
        "timezone": "America/Chicago",
        "slot": {"date": "2026-06-13", "start": "09:00", "end": "18:00"},
        "match_settings": {"rated": True, "length_games": 5},
        "predicates": [],
        "pools": [
            {
                "id": "p-os-1",
                "name": "Pool A",
                "slot": {"date": "2026-06-13", "start": "09:00", "end": "12:30"},
                "table_ids": ["t1"],
            }
        ],
    }
    payload.update(overrides)
    return payload


async def _create_event(
    client: AsyncClient, **overrides: Any
) -> tuple[uuid.UUID, uuid.UUID]:
    """Create a tournament and one event through the API; return both ids."""
    tournament = await client.post("/v1/tournaments", json=_tournament_payload())
    assert tournament.status_code == 201, tournament.text
    tournament_id = tournament.json()["id"]
    event = await client.post(
        f"/v1/tournaments/{tournament_id}/events", json=_event_payload(**overrides)
    )
    assert event.status_code == 201, event.text
    return uuid.UUID(tournament_id), uuid.UUID(event.json()["id"])


async def _load_events(
    db: AsyncSession, *event_ids: uuid.UUID
) -> list[TournamentEvent]:
    """Re-read the named events FROM THE DATABASE.

    ``expire_all`` first, and only once for the whole batch: the API client shares
    this session, so without it an assertion could be satisfied by the very
    in-memory objects the request left behind rather than by what was written. (It
    has to be once, not once per event — a second ``expire_all`` would expire the
    rows the first load just populated.)
    """
    db.expire_all()
    loaded = []
    for event_id in event_ids:
        loaded.append(
            (
                await db.execute(
                    select(TournamentEvent).where(TournamentEvent.id == event_id)
                )
            ).scalar_one()
        )
    return loaded


async def test_creating_an_event_creates_one_settings_row_with_its_draw_type(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """The event's ``draw_settings_id`` resolves to exactly one row, and that row
    names the draw type the request asked for.

    Asserted from the DATABASE, by the very join the demo runs — the response body
    is unchanged by this work, so a wire assertion would be evidence about nothing.
    """
    client, _ = authed_client
    _, event_id = await _create_event(client, draw_type="round-robin")

    joined = (
        await db_session.execute(
            select(
                TournamentEvent.name,
                TournamentEventDrawSettings.draw_type_key,
            ).join(
                TournamentEventDrawSettings,
                TournamentEventDrawSettings.id == TournamentEvent.draw_settings_id,
            )
        )
    ).all()

    assert len(joined) == 1, f"expected one event joined to one settings row: {joined}"
    (row,) = joined
    assert row.name == "Open Singles"
    assert row.draw_type_key == "round-robin"

    # Exactly one settings row was written — not one per request, not none.
    total = (
        await db_session.execute(
            select(func.count()).select_from(TournamentEventDrawSettings)
        )
    ).scalar_one()
    assert total == 1

    (event,) = await _load_events(db_session, event_id)
    assert event.draw_settings.draw_type is DrawType.round_robin


async def test_a_second_event_gets_a_settings_row_of_its_own(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """Rows are never shared between events — a second event with the SAME draw
    type still gets its own row, because the follow-on tickets hang per-event
    configuration (pools, ``qualifiers_per_pool``) off it."""
    client, _ = authed_client
    tournament_id, first_id = await _create_event(client, draw_type="round-robin")
    second = await client.post(
        f"/v1/tournaments/{tournament_id}/events",
        json=_event_payload(name="Second Singles", draw_type="round-robin"),
    )
    assert second.status_code == 201, second.text
    second_id = uuid.UUID(second.json()["id"])

    first, other = await _load_events(db_session, first_id, second_id)
    assert first.draw_settings_id != other.draw_settings_id


async def test_changing_an_events_draw_type_moves_its_settings_row_with_it(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """The update verb is the only thing that can move an event's draw type after
    create, and the settings row is where it has to land.

    ``draw_type`` is NOT a mapped column on the event, so ``update_event`` routes it
    out of its generic ``setattr`` loop by hand. This is the test that catches it
    going back in: a ``setattr(event, "draw_type", ...)`` binds an unmapped Python
    attribute, the request still answers 200, and the edit is silently dropped."""
    client, _ = authed_client
    tournament_id, event_id = await _create_event(client, draw_type="round-robin")

    response = await client.patch(
        f"/v1/tournaments/{tournament_id}/events/{event_id}",
        json={"draw_type": "single-elim"},
    )
    assert response.status_code == 200, response.text
    assert response.json()["draw_type"] == "single-elim", response.text

    (event,) = await _load_events(db_session, event_id)
    assert event.draw_settings.draw_type is DrawType.single_elim

    # Moved, not multiplied: the event keeps one settings row.
    total = (
        await db_session.execute(
            select(func.count()).select_from(TournamentEventDrawSettings)
        )
    ).scalar_one()
    assert total == 1


async def test_a_patch_that_leaves_the_draw_type_alone_leaves_the_row_alone(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """An edit to something else must not disturb the draw settings — the write in
    ``update_event`` is conditional on ``draw_type`` actually being in the payload."""
    client, _ = authed_client
    tournament_id, event_id = await _create_event(client, draw_type="single-elim")

    response = await client.patch(
        f"/v1/tournaments/{tournament_id}/events/{event_id}",
        json={"name": "Renamed Singles"},
    )
    assert response.status_code == 200, response.text

    (event,) = await _load_events(db_session, event_id)
    assert event.name == "Renamed Singles"
    assert event.draw_settings.draw_type is DrawType.single_elim


async def test_reading_draw_settings_off_a_freshly_loaded_event_needs_no_loader(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """Async SQLAlchemy raises rather than emitting a lazy load, so a reader that
    reaches ``event.draw_settings`` on an event loaded WITHOUT an explicit
    ``joinedload`` would blow up — which is exactly what the readers moving onto
    this row next will do. The relationship declares ``lazy="joined"`` so it
    doesn't; this test is what would red if that were removed."""
    client, _ = authed_client
    _, event_id = await _create_event(client, draw_type="round-robin")

    # A brand-new session's worth of state: nothing this test did could have
    # populated the relationship.
    db_session.expire_all()
    event = (
        await db_session.execute(
            select(TournamentEvent).where(TournamentEvent.id == event_id)
        )
    ).scalar_one()

    assert event.draw_settings.draw_type is DrawType.round_robin


async def _settings_row_count(db: AsyncSession) -> int:
    """How many ``tournament_event_draw_settings`` rows exist right now.

    ``expire_all`` first for the same reason ``_load_events`` does it: the API client
    shares this session, so a count served from a stale snapshot would be evidence
    about the test's own memory rather than about the database.
    """
    db.expire_all()
    return (
        await db.execute(select(func.count()).select_from(TournamentEventDrawSettings))
    ).scalar_one()


async def test_deleting_an_event_takes_its_settings_row_with_it(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """No orphans on the event-delete path.

    Nothing in the database does this for us. The FK runs event → settings, so a
    settings row has no ``event_id`` to be cascaded along and Postgres will happily
    keep it forever with zero referrers. It is the ORM's ``delete-orphan`` on
    ``TournamentEvent.draw_settings`` that reaps it, which also fixes the ORDER: the
    event holds an ``ON DELETE RESTRICT`` FK, so its row must go first.

    Measured through the real route (204 leaving the row behind is exactly what this
    reproduced before the fix), and asserted as a return to the count from *before*
    the event existed — an absolute ``== 0`` would pass on a suite that had leaked a
    row and then truncated.
    """
    client, _ = authed_client
    before = await _settings_row_count(db_session)
    tournament_id, event_id = await _create_event(client, draw_type="round-robin")
    assert await _settings_row_count(db_session) == before + 1

    response = await client.delete(f"/v1/tournaments/{tournament_id}/events/{event_id}")
    assert response.status_code == 204, response.text

    assert await _settings_row_count(db_session) == before


async def test_deleting_a_tournament_takes_its_events_settings_rows_with_it(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """No orphans on the tournament-delete path either — and it is a DIFFERENT
    mechanism, which is why it is a different test.

    ``tournament_events.tournament_id`` is ``ON DELETE CASCADE``, and
    ``Tournament.events`` is ``passive_deletes=True``: the events are swept by
    Postgres without the ORM ever instantiating them, so the ``delete-orphan`` that
    covers the test above never runs here. ``delete_tournament`` collects the
    settings ids before the delete and reaps them after it.

    Two events, so a fix that only reaped the first one reds.
    """
    client, _ = authed_client
    before = await _settings_row_count(db_session)
    tournament_id, _ = await _create_event(client, draw_type="round-robin")
    second = await client.post(
        f"/v1/tournaments/{tournament_id}/events",
        json=_event_payload(name="Second Singles", draw_type="single-elim"),
    )
    assert second.status_code == 201, second.text
    assert await _settings_row_count(db_session) == before + 2

    response = await client.delete(f"/v1/tournaments/{tournament_id}")
    assert response.status_code == 204, response.text

    assert await _settings_row_count(db_session) == before


async def test_a_settings_row_naming_an_unseeded_draw_type_is_refused(
    db_session: AsyncSession,
) -> None:
    """The FK to ``draw_types.key`` is the enforcement, and this is the test that
    makes it one.

    ``swiss`` is a draw type the product does not run: it has no ``DrawType``
    member and therefore no seeded row (ADR "a draw type is a seeded row, and the
    enum holds only what runs"). Written with raw SQL on purpose — the ORM path
    goes through ``for_draw_type``, which cannot produce an unseeded slug, so only
    a hand-written INSERT can ask the database the question.

    A seeded slug is inserted first, so a green result cannot be explained by the
    table or the statement being wrong.
    """
    seeded = await db_session.execute(
        sa.text(
            "INSERT INTO tournament_event_draw_settings (draw_type_key)"
            " VALUES ('round-robin') RETURNING id"
        )
    )
    assert seeded.scalar_one() is not None

    with pytest.raises(IntegrityError) as refusal:
        await db_session.execute(
            sa.text(
                "INSERT INTO tournament_event_draw_settings (draw_type_key)"
                " VALUES ('swiss')"
            )
        )
    assert "draw_type_key" in str(refusal.value)
    await db_session.rollback()


# The slug the qualifier count belongs to, taken **from the enum** — since #1227
# ``rr-then-ko`` is a real ``DrawType`` member with a seeded lookup row (the autouse
# ``draw_types`` fixture stands one up per enum member), so these tests no longer
# have to insert a test-local parent row to reach the constraint's active half.
RR_THEN_KO = DrawType.rr_then_ko.value


async def test_a_new_events_settings_row_carries_no_qualifier_count(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """A round-robin event's settings row has ``qualifiers_per_pool`` NULL — not 0,
    and not "unset but present".

    ``NULL`` is the whole representation of "this draw type takes no qualifier
    count" (ADR "rr-then-ko cuts both stages upfront"). A default of ``0`` would
    make every round-robin event carry a number that reads as a real configuration
    and that the ``K >= 1`` floor would then contradict.
    """
    client, _ = authed_client
    _, event_id = await _create_event(client, draw_type="round-robin")

    (event,) = await _load_events(db_session, event_id)
    assert event.draw_settings.draw_type is DrawType.round_robin
    assert event.draw_settings.qualifiers_per_pool is None


async def test_a_settings_row_that_is_not_rr_then_ko_may_not_carry_a_qualifier_count(
    db_session: AsyncSession,
) -> None:
    """The qualifier count is unrepresentable on any other draw type — refused by
    the database, not dropped on the way in.

    This is the storage-layer half of the claim the request boundary makes: "top K
    from each pool advance" is meaningless for a round-robin (there is no cut to
    size) and for a single-elim (there are no pools to cut from), so a row pairing
    either slug with a number is not a row Postgres will accept. Both other slugs
    are asked, because a constraint that only covered one of them would look
    identical on a one-slug test.

    A NULL-carrying row of each slug is inserted first, so a green result cannot be
    explained by the table or the statements being wrong.
    """
    for slug in ("round-robin", "single-elim"):
        accepted = await db_session.execute(
            sa.text(
                "INSERT INTO tournament_event_draw_settings"
                " (draw_type_key, qualifiers_per_pool)"
                " VALUES (:slug, NULL) RETURNING qualifiers_per_pool"
            ),
            {"slug": slug},
        )
        assert accepted.scalar_one() is None

        with pytest.raises(IntegrityError) as refusal:
            async with db_session.begin_nested():
                await db_session.execute(
                    sa.text(
                        "INSERT INTO tournament_event_draw_settings"
                        " (draw_type_key, qualifiers_per_pool)"
                        " VALUES (:slug, 2)"
                    ),
                    {"slug": slug},
                )
        assert "ck_tournament_event_draw_settings_qualifiers_per_pool" in str(
            refusal.value
        ), f"{slug} accepted a qualifier count: {refusal.value}"

    await db_session.rollback()


async def test_an_rr_then_ko_settings_row_round_trips_its_qualifier_count(
    db_session: AsyncSession,
) -> None:
    """The column is a real, readable configuration for the one draw type that has
    one: written as 2, read back as 2.

    Driven through raw SQL rather than through the HTTP boundary because the subject
    is the **column and its CHECK**, not the route: the end-to-end path an
    ``rr-then-ko`` event now takes is covered in ``test_tournaments.py``.
    """
    settings_id = (
        await db_session.execute(
            sa.text(
                "INSERT INTO tournament_event_draw_settings"
                " (draw_type_key, qualifiers_per_pool)"
                " VALUES (:key, 2) RETURNING id"
            ),
            {"key": RR_THEN_KO},
        )
    ).scalar_one()

    db_session.expire_all()
    stored = (
        await db_session.execute(
            select(TournamentEventDrawSettings).where(
                TournamentEventDrawSettings.id == settings_id
            )
        )
    ).scalar_one()
    assert stored.draw_type_key == RR_THEN_KO
    assert stored.qualifiers_per_pool == 2

    await db_session.rollback()


async def test_an_rr_then_ko_settings_row_needs_at_least_one_qualifier(
    db_session: AsyncSession,
) -> None:
    """``K >= 1`` is the STATIC half of the ADR's legal configuration space, so it
    is a floor the row itself carries — zero, negative and absent are all refused.

    A qualifier count of zero advances nobody, which is not a knockout stage; a
    negative one is not a count at all; and an absent one leaves an ``rr-then-ko``
    row with no answer to "how many advance", which the cut has no default for. The
    two bounds that MOVE with the entrant count — ``P × K >= 2`` and ``K <= ⌊N/P⌋``
    — are deliberately NOT here: they are refused at the cut as ``DegenerateDraw``,
    because a row that was legal when written must not become unwritable when a
    player withdraws.
    """
    for count in ("0", "-1", "NULL"):
        with pytest.raises(IntegrityError) as refusal:
            async with db_session.begin_nested():
                await db_session.execute(
                    sa.text(
                        "INSERT INTO tournament_event_draw_settings"
                        " (draw_type_key, qualifiers_per_pool)"
                        f" VALUES (:key, {count})"
                    ),
                    {"key": RR_THEN_KO},
                )
        assert "ck_tournament_event_draw_settings_qualifiers_per_pool" in str(
            refusal.value
        ), f"qualifiers_per_pool={count} was accepted: {refusal.value}"

    # One qualifier per pool IS legal — a two-pool event at K=1 is a single final
    # between the two pool winners, which the ADR names as a supported shape. So the
    # floor is at 1, not at 2, and this is what says the refusals above are the
    # constraint discriminating rather than rejecting everything.
    accepted = await db_session.execute(
        sa.text(
            "INSERT INTO tournament_event_draw_settings"
            " (draw_type_key, qualifiers_per_pool)"
            " VALUES (:key, 1) RETURNING qualifiers_per_pool"
        ),
        {"key": RR_THEN_KO},
    )
    assert accepted.scalar_one() == 1

    await db_session.rollback()


async def test_a_seeded_draw_type_cannot_be_deleted_while_an_event_uses_it(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """The other half of ``ON DELETE RESTRICT``: the reference row cannot be pulled
    out from under a settings row that names it."""
    client, _ = authed_client
    await _create_event(client, draw_type="round-robin")

    with pytest.raises(IntegrityError):
        await db_session.execute(
            sa.text("DELETE FROM draw_types WHERE key = 'round-robin'")
        )
    await db_session.rollback()

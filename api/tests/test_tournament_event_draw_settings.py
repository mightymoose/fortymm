"""An event's draw configuration is a row, and the row is what the database
constrains (ADR "an event's draw configuration is a row, not a column").

Four claims, and they are separate ones:

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
* **The row's ``settings`` column is one NOT NULL JSON object, and an arm round-trips
  through it** (ADR "a draw type's settings are one NOT NULL JSON object"). The
  database's remaining opinion is only that the value is an object; which settings
  belong to which draw type is the discriminated union's rule, at the request boundary.

The draw type has exactly one home — ``tournament_event_draw_settings.draw_type_key``
— so these tests read it from there and nowhere else. There is no ``draw_type``
column on ``tournament_events`` to cross-check it against, which is the point.
"""

import uuid
from collections.abc import AsyncIterator
from itertools import product
from typing import Any, get_args

import pytest
import pytest_asyncio
import sqlalchemy as sa
from httpx import AsyncClient
from pydantic import ValidationError
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    DrawType,
    TournamentEvent,
    TournamentEventDrawSettings,
    User,
)
from app.schemas.tournament import (
    DrawSettingsWrite,
    DrawSettingsWriteArm,
    DrawStructure,
    PoolMembershipMode,
    RoundRobinDrawSettingsWrite,
    RrThenKoDrawSettingsWrite,
    SingleElimDrawSettingsWrite,
    StructuralSettingOwner,
    SwissDrawSettingsWrite,
    draw_settings_from_storage,
)
from app.tournament_draw_settings import draw_settings_of, draw_settings_row
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
        "table_catalogue": [{"label": "Table 1", "court": "A"}],
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

    ``double-elim`` is a draw type the product does not run: it has no ``DrawType``
    member and therefore no seeded row (ADR "a draw type is a seeded row, and the
    enum holds only what runs"). It took this test's place from ``swiss``, which
    shipped — the list of unseeded slugs shrinks by exactly the format that lands,
    which is the mechanism working. Written with raw SQL on purpose — the ORM path
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
                " VALUES ('double-elim')"
            )
        )
    assert "draw_type_key" in str(refusal.value)
    await db_session.rollback()


# The slug the qualifier count belongs to, taken **from the enum** — since #1227
# ``rr-then-ko`` is a real ``DrawType`` member with a seeded lookup row (the autouse
# ``draw_types`` fixture stands one up per enum member), so these tests no longer
# have to insert a test-local parent row to reach the constraint's active half.
RR_THEN_KO = DrawType.rr_then_ko.value


def test_every_draw_type_has_an_arm_in_the_write_union() -> None:
    """``DrawSettingsWrite`` is the request-boundary twin of this table's ``CHECK``:
    the union says which configuration each draw type may carry, and the constraint
    says the same thing about the row it lands on.

    Unlike the four dispatch sites (``strategy_for``, ``results_for``, …), a
    **discriminated union is not exhaustive by construction** — a new ``DrawType``
    member with no arm type-checks perfectly and surfaces as a 422 in a director's
    request, at the moment they try to create the event. So the totality those sites
    get from a catch-all-free ``match`` is asserted here instead, exactly as its
    siblings do it (``for draw_type in DrawType`` in ``test_draws`` /
    ``test_results``): a member added without an arm reds in CI, not in production.

    The discriminator is read off each arm's ``draw_type`` **field default** rather
    than by parsing a payload per arm, because the payloads differ (``rr-then-ko``
    requires its qualifier count) and the claim here is about the union's *shape*, not
    about what any one arm accepts.
    """
    arms = get_args(get_args(DrawSettingsWrite)[0])
    discriminators = [arm.model_fields["draw_type"].default for arm in arms]

    assert {discriminator.value for discriminator in discriminators} == {
        draw_type.value for draw_type in DrawType
    }
    # One arm per member, so two arms tagged with the same slug (a copy/paste that
    # leaves a member uncovered while the set above still matches) also reds.
    assert len(discriminators) == len(DrawType)


async def test_a_new_events_settings_row_carries_an_empty_settings_object(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """A round-robin event's settings row stores ``{}`` — not ``NULL``, and not a
    key with an empty value.

    The empty object is the whole representation of "this draw type takes no
    configuration" (ADR "a draw type's settings are one NOT NULL JSON object"). A
    ``NULL`` would mean the same thing to every reader, which is precisely why only
    one of the two may be representable: nothing has to test for absence before it
    reads, and the parse below has one shape to handle rather than two.
    """
    client, _ = authed_client
    _, event_id = await _create_event(client, draw_type="round-robin")

    (event,) = await _load_events(db_session, event_id)
    assert event.draw_settings.draw_type is DrawType.round_robin
    assert event.draw_settings.settings == {}
    assert draw_settings_of(event.draw_settings) == RoundRobinDrawSettingsWrite()


async def test_the_settings_column_holds_an_object_or_nothing_at_all(
    db_session: AsyncSession,
) -> None:
    """What the database still has an opinion on: ``settings`` is a JSON **object**,
    and it is NOT NULL.

    This is all that is left of the storage-layer guard, and deliberately so (ADR "a
    draw type's settings are one NOT NULL JSON object"). The ``CASE`` constraint that
    paired a qualifier count with its draw type went away with the column it guarded;
    which settings belong to which draw type is now the discriminated union's rule,
    refused at the request boundary with a 422 and pinned by
    :func:`test_every_draw_type_has_an_arm_in_the_write_union` above.

    A list, a number, a string and a JSON ``null`` are each a stored "settings" that
    means nothing, so each is asked separately — a constraint that had been written as
    ``settings IS NOT NULL`` would accept every one of them and still look green on a
    one-case test. Accepted objects are asked too, so the refusals are the constraint
    discriminating rather than rejecting everything.
    """
    accepted = ("'{}'::jsonb", "'{\"qualifiers_per_pool\": 2}'::jsonb")
    refused = ("'[]'::jsonb", "'1'::jsonb", "'\"nope\"'::jsonb", "'null'::jsonb")

    for value in accepted:
        async with db_session.begin_nested():
            stored = await db_session.execute(
                sa.text(
                    "INSERT INTO tournament_event_draw_settings"
                    " (draw_type_key, settings)"
                    f" VALUES (:key, {value}) RETURNING settings"
                ),
                {"key": RR_THEN_KO},
            )
            assert stored.scalar_one() is not None, value

    # Each refusal names the constraint that must produce it, not merely "something
    # refused this". SQLAlchemy embeds the failing statement in the error, and that
    # statement always contains the word "settings" — it is the column being inserted —
    # so a substring check for "settings" passes for ANY IntegrityError this INSERT can
    # raise and discriminates nothing at all.
    #
    # The two refusals are genuinely different constraints and are asked separately: a
    # JSON value that is not an object is the CHECK's job, and a SQL NULL is
    # ``nullable=False``'s. Asserting one name over both cases would have to be loose
    # enough to accept either, which is how the non-discriminating version got written.
    for value in refused:
        with pytest.raises(IntegrityError) as refusal:
            async with db_session.begin_nested():
                await db_session.execute(
                    sa.text(
                        "INSERT INTO tournament_event_draw_settings"
                        " (draw_type_key, settings)"
                        f" VALUES (:key, {value})"
                    ),
                    {"key": RR_THEN_KO},
                )
        assert "ck_tournament_event_draw_settings_settings_object" in str(
            refusal.value
        ), (
            f"settings={value} is a JSON value that is not an object, so the object "
            f"CHECK must be what refuses it: {refusal.value}"
        )

    with pytest.raises(IntegrityError) as null_refusal:
        async with db_session.begin_nested():
            await db_session.execute(
                sa.text(
                    "INSERT INTO tournament_event_draw_settings"
                    " (draw_type_key, settings)"
                    " VALUES (:key, NULL)"
                ),
                {"key": RR_THEN_KO},
            )
    assert "not-null" in str(null_refusal.value).lower(), (
        "a SQL NULL must be refused by the column's NOT NULL, not by the object CHECK "
        f"— jsonb_typeof(NULL) is NULL, which a CHECK passes: {null_refusal.value}"
    )

    await db_session.rollback()


async def test_every_arm_round_trips_through_the_settings_column(
    db_session: AsyncSession,
) -> None:
    """The claim the whole change turns on: an arm written onto a row and read back
    off it is the **same arm**.

    Both directions go through ``app.tournament_draw_settings`` — the one storage
    boundary for this column — so this is what says the encode and the decode agree.
    Every arm is asked, including the configured one, because a round trip that only
    covers the empty object would be satisfied by an encoder that drops every setting
    on the floor.

    The row is flushed and expired before the read, so what is parsed is what Postgres
    stored and not the dict the encoder left in memory.
    """
    arms: list[DrawSettingsWriteArm] = [
        RoundRobinDrawSettingsWrite(),
        SingleElimDrawSettingsWrite(),
        RrThenKoDrawSettingsWrite(qualifiers_per_pool=2),
        SwissDrawSettingsWrite(rounds=5),
    ]
    assert len(arms) == len(DrawType), (
        "a draw type has been added without an arm in this round trip: "
        f"{sorted(t.value for t in DrawType)}"
    )

    rows = [draw_settings_row(arm) for arm in arms]
    db_session.add_all(rows)
    await db_session.flush()
    ids = [row.id for row in rows]
    db_session.expire_all()

    for arm, settings_id in zip(arms, ids, strict=True):
        stored = (
            await db_session.execute(
                select(TournamentEventDrawSettings).where(
                    TournamentEventDrawSettings.id == settings_id
                )
            )
        ).scalar_one()
        assert stored.draw_type_key == arm.draw_type.value
        assert draw_settings_of(stored) == arm

    await db_session.rollback()


async def test_the_qualifier_floor_is_the_unions_now_that_the_column_is_gone(
    db_session: AsyncSession,
) -> None:
    """``K >= 1`` is the STATIC half of the ADR's legal configuration space, and since
    the settings column became one JSON object it is enforced in exactly one place: the
    union arm.

    Zero advances nobody, a negative one is not a count, and an absent one leaves an
    ``rr-then-ko`` configuration with no answer to "how many advance". All three are a
    refusal where the arm is built — at the request boundary, as a 422 naming the field
    — rather than an ``IntegrityError`` from a ``CHECK`` that no longer exists.

    The database's part is asserted too, and it is the *absence* of an opinion: a
    settings object carrying ``0`` is a row Postgres now accepts. That is the loss the
    ADR takes deliberately, and stating it here is what keeps it a decision rather than
    a regression somebody discovers.

    The two bounds that MOVE with the entrant count — ``P × K >= 2`` and
    ``K <= ⌊N/P⌋`` — are deliberately NOT here: they are refused at the cut as
    ``DegenerateDraw``, because a configuration that was legal when written must not
    become unwritable when a player withdraws.
    """
    for count in (0, -1):
        with pytest.raises(ValidationError, match="qualifiers_per_pool"):
            draw_settings_from_storage(
                DrawType.rr_then_ko, {"qualifiers_per_pool": count}
            )
    with pytest.raises(ValidationError, match="qualifiers_per_pool"):
        draw_settings_from_storage(DrawType.rr_then_ko, {})

    # One qualifier per pool IS legal — a two-pool event at K=1 is a single final
    # between the two pool winners, which the ADR names as a supported shape. So the
    # floor is at 1, not at 2, and this is what says the refusals above are the union
    # discriminating rather than rejecting everything.
    assert draw_settings_from_storage(
        DrawType.rr_then_ko, {"qualifiers_per_pool": 1}
    ) == RrThenKoDrawSettingsWrite(qualifiers_per_pool=1)

    # And the storage layer no longer has a view: the same K the union refuses is a row
    # the database stores. Named out loud, because a reader who assumes the old CHECK
    # is still there would be wrong about where this rule lives.
    stored = await db_session.execute(
        sa.text(
            "INSERT INTO tournament_event_draw_settings (draw_type_key, settings)"
            " VALUES (:key, '{\"qualifiers_per_pool\": 0}'::jsonb) RETURNING settings"
        ),
        {"key": RR_THEN_KO},
    )
    assert stored.scalar_one() == {"qualifiers_per_pool": 0}

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


# ----- the draw structure: who owns each setting (#1320) --------------------
#
# ADR "a structural setting is owned by the director or derived by the system". The
# ownership modes are four more keys inside the SAME settings object, which is what
# makes them free of a migration (ADR "a draw type's settings are one NOT NULL JSON
# object"). So the two claims that matter here are storage claims: an event written
# before the keys existed still reads, and every combination of the keys survives the
# round trip.

#: The two ownership modes, and the two membership modes — spelled as tuples so the
#: combination sweep below is a ``product`` over them rather than sixteen literals.
OWNERS = (StructuralSettingOwner.automatic, StructuralSettingOwner.manual)
MEMBERSHIPS = (PoolMembershipMode.snake, PoolMembershipMode.manual)

#: Three DIFFERENT numbers, on purpose. A sweep that used one number for the pool count,
#: the pool size and the qualifier count would stay green against an encoder that wrote
#: any of them into the wrong key.
MANUAL_POOL_COUNT = 6
MANUAL_POOL_SIZE = 5
MANUAL_QUALIFIERS = 3


async def test_an_event_stored_before_the_draw_structure_reads_as_all_automatic(
    db_session: AsyncSession,
) -> None:
    """**The no-migration claim.** A settings object carrying none of the ownership keys
    — which is every ``rr-then-ko`` event written before #1320 — parses into every mode
    automatic and no manual numbers.

    That is not a convenience. ADR "a structural setting is owned by the director or
    derived by the system" says setting nothing must reproduce today's behaviour, and
    today's behaviour IS all-automatic: the pool count is the pool row count, the pool
    size is the field split across those rows, membership is the snake, and the
    qualifier count is the one the director already typed. So an existing event needs no
    backfill and gets none — the row is left exactly as it was written, which this test
    asserts of the stored blob as well as of the parse.

    Both halves are asserted separately. A default change on the ``manual_*`` fields
    would slip past a test that only checked the modes, and vice versa.
    """
    parsed = draw_settings_from_storage(
        DrawType.rr_then_ko, {"qualifiers_per_pool": MANUAL_QUALIFIERS}
    )
    assert isinstance(parsed, RrThenKoDrawSettingsWrite)
    structure = parsed.draw_structure
    assert structure.pool_count_mode is StructuralSettingOwner.automatic
    assert structure.pool_size_mode is StructuralSettingOwner.automatic
    assert structure.qualifiers_mode is StructuralSettingOwner.automatic
    assert structure.membership_mode is PoolMembershipMode.snake
    assert structure.manual_pool_count is None
    assert structure.manual_pool_size is None

    # And through a real row written the way a pre-#1320 event's row was written: the
    # raw-mapping door, which does not parse (see ``for_draw_type``'s docstring). What
    # comes back out of Postgres is the object that went in, with nothing added to it.
    row = TournamentEventDrawSettings.for_draw_type(
        DrawType.rr_then_ko, settings={"qualifiers_per_pool": MANUAL_QUALIFIERS}
    )
    db_session.add(row)
    await db_session.flush()
    settings_id = row.id
    db_session.expire_all()

    stored = (
        await db_session.execute(
            select(TournamentEventDrawSettings).where(
                TournamentEventDrawSettings.id == settings_id
            )
        )
    ).scalar_one()
    assert stored.settings == {"qualifiers_per_pool": MANUAL_QUALIFIERS}, (
        "an event that predates this work must not be rewritten by reading it: the "
        "absent keys ARE the automatic modes"
    )
    assert draw_settings_of(stored) == RrThenKoDrawSettingsWrite(
        qualifiers_per_pool=MANUAL_QUALIFIERS
    )

    await db_session.rollback()


async def test_every_combination_of_ownership_modes_round_trips(
    db_session: AsyncSession,
) -> None:
    """What is written is what is read, for all sixteen combinations of the four modes.

    Every combination carries **both** manual numbers, including the combinations whose
    modes are automatic. That is deliberate: a manual number is kept while its mode is
    automatic (see
    :func:`test_a_manual_number_is_kept_while_its_mode_is_automatic`), so a sweep that
    only attached numbers to manual modes would never exercise the pairing the product
    actually stores.

    The rows are flushed and expired before the read, so what is parsed is what Postgres
    holds rather than the dict the encoder left in memory.
    """
    structures = [
        DrawStructure(
            pool_count_mode=count_mode,
            manual_pool_count=MANUAL_POOL_COUNT,
            pool_size_mode=size_mode,
            manual_pool_size=MANUAL_POOL_SIZE,
            qualifiers_mode=qualifiers_mode,
            membership_mode=membership,
        )
        for count_mode, size_mode, qualifiers_mode, membership in product(
            OWNERS, OWNERS, OWNERS, MEMBERSHIPS
        )
    ]
    assert len(structures) == 16, "2 × 2 × 2 ownership modes × 2 membership modes"

    arms = [
        RrThenKoDrawSettingsWrite(
            qualifiers_per_pool=MANUAL_QUALIFIERS, draw_structure=structure
        )
        for structure in structures
    ]
    rows = [draw_settings_row(arm) for arm in arms]
    db_session.add_all(rows)
    await db_session.flush()
    ids = [row.id for row in rows]
    db_session.expire_all()

    for arm, settings_id in zip(arms, ids, strict=True):
        stored = (
            await db_session.execute(
                select(TournamentEventDrawSettings).where(
                    TournamentEventDrawSettings.id == settings_id
                )
            )
        ).scalar_one()
        assert draw_settings_of(stored) == arm, arm.draw_structure

    # The stored shape itself, asserted once: the modes are their wire slugs inside one
    # nested object beside the qualifier count, not enum reprs and not six flat keys. An
    # equality over the whole blob is what would red if a key were renamed, since the
    # round trip above would go on agreeing with itself.
    all_manual = (
        await db_session.execute(
            select(TournamentEventDrawSettings).where(
                TournamentEventDrawSettings.id == ids[-1]
            )
        )
    ).scalar_one()
    assert all_manual.settings == {
        "qualifiers_per_pool": MANUAL_QUALIFIERS,
        "draw_structure": {
            "pool_count_mode": "manual",
            "manual_pool_count": MANUAL_POOL_COUNT,
            "pool_size_mode": "manual",
            "manual_pool_size": MANUAL_POOL_SIZE,
            "qualifiers_mode": "manual",
            "membership_mode": "manual",
        },
    }

    await db_session.rollback()


async def test_a_manual_number_is_kept_while_its_mode_is_automatic(
    db_session: AsyncSession,
) -> None:
    """**The retention decision, stated as a test.** A pool count and a pool size the
    director typed are kept when their modes go back to automatic. They are not dropped.

    A manual number with an automatic mode is therefore a legal stored state, and it
    means one thing only: this is the director's number, remembered. Nothing derives
    anything from it while the mode is automatic — the mode is the only thing a reader
    asks — so the pair cannot contradict itself.

    The alternative (clear the number when the mode goes automatic) was rejected because
    a director who switches a row to Automatic to see what the system would say, and
    then switches back, would be handed an empty box instead of their own number.
    """
    remembered = DrawStructure(
        pool_count_mode=StructuralSettingOwner.automatic,
        manual_pool_count=MANUAL_POOL_COUNT,
        pool_size_mode=StructuralSettingOwner.automatic,
        manual_pool_size=MANUAL_POOL_SIZE,
    )
    row = draw_settings_row(
        RrThenKoDrawSettingsWrite(
            qualifiers_per_pool=MANUAL_QUALIFIERS, draw_structure=remembered
        )
    )
    db_session.add(row)
    await db_session.flush()
    settings_id = row.id
    db_session.expire_all()

    stored = (
        await db_session.execute(
            select(TournamentEventDrawSettings).where(
                TournamentEventDrawSettings.id == settings_id
            )
        )
    ).scalar_one()
    parsed = draw_settings_of(stored)
    assert isinstance(parsed, RrThenKoDrawSettingsWrite)
    assert parsed.draw_structure.manual_pool_count == MANUAL_POOL_COUNT
    assert parsed.draw_structure.manual_pool_size == MANUAL_POOL_SIZE
    assert parsed.draw_structure.pool_count_mode is StructuralSettingOwner.automatic
    assert parsed.draw_structure.pool_size_mode is StructuralSettingOwner.automatic

    await db_session.rollback()


async def test_a_directors_structure_survives_create_patch_and_re_read(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """The whole seam, over HTTP: a structure sent on create reads back on create, is
    still there in the database, and a PATCH replaces it.

    The PATCH half is the one a storage-level round trip cannot cover. The ownership
    modes are a key inside the settings row's JSON object and not a column on the event,
    so an edit routed through the update verb's generic ``setattr`` loop would bind an
    attribute the mapper never persists — accepted, and dropped. This asserts the
    database after the edit, not the response body the edit returned.
    """
    client, _ = authed_client
    created_structure = {
        "pool_count_mode": "manual",
        "manual_pool_count": MANUAL_POOL_COUNT,
        "pool_size_mode": "automatic",
        "manual_pool_size": None,
        "qualifiers_mode": "manual",
        "membership_mode": "snake",
    }
    tournament = await client.post("/v1/tournaments", json=_tournament_payload())
    assert tournament.status_code == 201, tournament.text
    tournament_id = tournament.json()["id"]
    created = await client.post(
        f"/v1/tournaments/{tournament_id}/events",
        json=_event_payload(
            draw_type="rr-then-ko",
            qualifiers_per_pool=MANUAL_QUALIFIERS,
            draw_structure=created_structure,
        ),
    )
    assert created.status_code == 201, created.text
    assert created.json()["draw_structure"] == created_structure
    event_id = uuid.UUID(created.json()["id"])

    (event,) = await _load_events(db_session, event_id)
    assert draw_settings_of(event.draw_settings) == RrThenKoDrawSettingsWrite(
        qualifiers_per_pool=MANUAL_QUALIFIERS,
        draw_structure=DrawStructure(
            pool_count_mode=StructuralSettingOwner.manual,
            manual_pool_count=MANUAL_POOL_COUNT,
            qualifiers_mode=StructuralSettingOwner.manual,
        ),
    )

    # The editor patches the draw configuration as a unit — type, count and structure
    # together — which is the shape the event form already sends.
    patched_structure = {
        "pool_count_mode": "automatic",
        "manual_pool_count": MANUAL_POOL_COUNT,
        "pool_size_mode": "manual",
        "manual_pool_size": MANUAL_POOL_SIZE,
        "qualifiers_mode": "automatic",
        "membership_mode": "manual",
    }
    patched = await client.patch(
        f"/v1/tournaments/{tournament_id}/events/{event_id}",
        json={
            "draw_type": "rr-then-ko",
            "qualifiers_per_pool": MANUAL_QUALIFIERS,
            "draw_structure": patched_structure,
        },
    )
    assert patched.status_code == 200, patched.text
    assert patched.json()["draw_structure"] == patched_structure

    (event,) = await _load_events(db_session, event_id)
    assert event.draw_settings.settings["draw_structure"] == patched_structure


async def test_a_draw_type_with_no_structure_refuses_one_and_reads_back_null(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """The ownership ADR is scoped to ``rr-then-ko``, and the union is what scopes it.

    A round-robin event has no knockout stage to aim at, so it has no pool-to-knockout
    settings: sending some is a 422 at the boundary (``extra="forbid"`` on the arm, the
    same refusal a qualifier count on a round-robin gets), and reading one back gives
    ``null`` — a fact about the draw type, not missing data.
    """
    client, _ = authed_client
    tournament = await client.post("/v1/tournaments", json=_tournament_payload())
    assert tournament.status_code == 201, tournament.text
    tournament_id = tournament.json()["id"]

    refused = await client.post(
        f"/v1/tournaments/{tournament_id}/events",
        json=_event_payload(
            draw_type="round-robin",
            draw_structure={"pool_count_mode": "manual", "manual_pool_count": 6},
        ),
    )
    assert refused.status_code == 422, refused.text
    assert "draw_structure" in refused.text

    created = await client.post(
        f"/v1/tournaments/{tournament_id}/events",
        json=_event_payload(draw_type="round-robin"),
    )
    assert created.status_code == 201, created.text
    assert created.json()["draw_structure"] is None

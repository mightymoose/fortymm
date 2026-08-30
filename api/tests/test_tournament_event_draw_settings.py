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

The draw type has exactly one home — ``tournament_event_draw_settings.draw_type_id``,
a FK onto ``draw_types.id`` (ADR 20260815, "draw_types gains a surrogate id primary
key") — so these tests read it from there and nowhere else: through the ORM's
``draw_type`` property where an assertion wants the enum, joining onto
``draw_types.key`` where a raw-SQL assertion wants the slug, or binding the id
straight from :data:`app.models.draw_type.DRAW_TYPE_IDS` where it doesn't need the
slug at all. There is no ``draw_type`` column on ``tournament_events`` to cross-check
it against, which is the point.
"""

import uuid
from collections.abc import AsyncIterator
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
    DrawTypeOption,
    TournamentEvent,
    TournamentEventDrawSettings,
    User,
)
from app.models.draw_type import DRAW_TYPE_IDS
from app.schemas.tournament import (
    DrawSettingsWrite,
    DrawSettingsWriteArm,
    RoundRobinDrawSettingsWrite,
    RrThenKoDrawSettingsWrite,
    SingleElimDrawSettingsWrite,
    SwissDrawSettingsWrite,
    draw_settings_from_storage,
)
from app.tournament_draw_settings import draw_settings_of, draw_settings_row
from app.tournaments import TOURNAMENT_CREATE
from tests._helpers import grant_permissions, patch_event, start_session


@pytest_asyncio.fixture
async def authed_client(
    api_client: AsyncClient, db_session: AsyncSession
) -> AsyncIterator[tuple[AsyncClient, User]]:
    """The shared ``api_client`` with a real session whose user holds
    ``tournament.view`` + ``tournament.create`` — the same genuine RBAC rows
    ``test_tournaments`` grants, not a dependency override."""
    user = await start_session(api_client, db_session)
    await grant_permissions(db_session, user, (TOURNAMENT_CREATE,))
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
        "reservations": [
            {
                "name": "Reservation A",
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
                DrawTypeOption.key,
            )
            .join(
                TournamentEventDrawSettings,
                TournamentEventDrawSettings.id == TournamentEvent.draw_settings_id,
            )
            .join(
                DrawTypeOption,
                DrawTypeOption.id == TournamentEventDrawSettings.draw_type_id,
            )
        )
    ).all()

    assert len(joined) == 1, f"expected one event joined to one settings row: {joined}"
    (row,) = joined
    assert row.name == "Open Singles"
    assert row.key == "round-robin"

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
    configuration (reservations, ``qualifiers_per_group``) off it."""
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

    response = await patch_event(
        client, tournament_id, event_id, {"draw_type": "single-elim"}
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

    response = await patch_event(
        client, tournament_id, event_id, {"name": "Renamed Singles"}
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
    """The FK to ``draw_types.id`` is the enforcement, and this is the test that
    makes it one.

    The domain subject comes first: ``double-elim`` is a draw type the product does
    not run, so it has no ``DrawType`` member and therefore no seeded row (ADR "a
    draw type is a seeded row, and the enum holds only what runs") — asserted
    directly, by asking the database for it and getting nothing back, rather than
    assumed. The refused insert below then names an id that could, for all this test
    otherwise knows, belong to exactly that missing row.

    Written with raw SQL on purpose — the ORM path goes through ``for_draw_type``,
    which can only produce a seeded id (:data:`app.models.draw_type.DRAW_TYPE_IDS`),
    so only a hand-written INSERT can ask the database the question.

    A seeded row is inserted first too (its id bound straight from
    :data:`app.models.draw_type.DRAW_TYPE_IDS` rather than resolved by a ``key``
    subselect), so a green result cannot be explained by the table or the statement
    being wrong.
    """
    unseeded = await db_session.execute(
        sa.text("SELECT id FROM draw_types WHERE key = 'double-elim'")
    )
    assert unseeded.first() is None

    seeded = await db_session.execute(
        sa.text(
            "INSERT INTO tournament_event_draw_settings (draw_type_id)"
            " VALUES (:draw_type_id) RETURNING id"
        ),
        {"draw_type_id": DRAW_TYPE_IDS[DrawType.round_robin]},
    )
    assert seeded.scalar_one() is not None

    with pytest.raises(IntegrityError) as refusal:
        await db_session.execute(
            sa.text(
                "INSERT INTO tournament_event_draw_settings (draw_type_id)"
                " VALUES (:draw_type_id)"
            ),
            {"draw_type_id": uuid.uuid4()},
        )
    assert "draw_type_id" in str(refusal.value)
    await db_session.rollback()


# The draw type the qualifier count belongs to, taken **from the enum** — since
# #1227 ``rr-then-ko`` is a real ``DrawType`` member with a seeded lookup row (the
# autouse ``draw_types`` fixture stands one up per enum member), so these tests no
# longer have to insert a test-local parent row to reach the constraint's active
# half. Bound as the seeded id directly (:data:`app.models.draw_type.DRAW_TYPE_IDS`)
# rather than resolved by ``key``, so the raw-SQL inserts below need no subselect.
RR_THEN_KO_ID = DRAW_TYPE_IDS[DrawType.rr_then_ko]


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
    accepted = ("'{}'::jsonb", "'{\"qualifiers_per_group\": 2}'::jsonb")
    refused = ("'[]'::jsonb", "'1'::jsonb", "'\"nope\"'::jsonb", "'null'::jsonb")

    for value in accepted:
        async with db_session.begin_nested():
            stored = await db_session.execute(
                sa.text(
                    "INSERT INTO tournament_event_draw_settings"
                    " (draw_type_id, settings)"
                    " VALUES (:draw_type_id,"
                    f" {value}) RETURNING settings"
                ),
                {"draw_type_id": RR_THEN_KO_ID},
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
                        " (draw_type_id, settings)"
                        " VALUES (:draw_type_id,"
                        f" {value})"
                    ),
                    {"draw_type_id": RR_THEN_KO_ID},
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
                    " (draw_type_id, settings)"
                    " VALUES (:draw_type_id, NULL)"
                ),
                {"draw_type_id": RR_THEN_KO_ID},
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
        RrThenKoDrawSettingsWrite(qualifiers_per_group=2),
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
        assert stored.draw_type is arm.draw_type
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
        with pytest.raises(ValidationError, match="qualifiers_per_group"):
            draw_settings_from_storage(
                DrawType.rr_then_ko, {"qualifiers_per_group": count}
            )
    with pytest.raises(ValidationError, match="qualifiers_per_group"):
        draw_settings_from_storage(DrawType.rr_then_ko, {})

    # One qualifier per group IS legal — a two-group event at K=1 is a single final
    # between the two group winners, which the ADR names as a supported shape. So the
    # floor is at 1, not at 2, and this is what says the refusals above are the union
    # discriminating rather than rejecting everything.
    assert draw_settings_from_storage(
        DrawType.rr_then_ko, {"qualifiers_per_group": 1}
    ) == RrThenKoDrawSettingsWrite(qualifiers_per_group=1)

    # And the storage layer no longer has a view: the same K the union refuses is a row
    # the database stores. Named out loud, because a reader who assumes the old CHECK
    # is still there would be wrong about where this rule lives.
    stored = await db_session.execute(
        sa.text(
            "INSERT INTO tournament_event_draw_settings (draw_type_id, settings)"
            " VALUES (:draw_type_id,"
            " '{\"qualifiers_per_group\": 0}'::jsonb) RETURNING settings"
        ),
        {"draw_type_id": RR_THEN_KO_ID},
    )
    assert stored.scalar_one() == {"qualifiers_per_group": 0}

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

"""Swiss, end to end as far as this slice goes (#1276, ADR "swiss pre-cuts every round
and pairs each one on advance").

The strategy itself is pure and is tested from literals in ``test_draws.py``; the
standings shape is tested the same way in ``test_results.py``. What this file tests is
everything *between* them and a director: the request boundary that requires a round
count for exactly one draw type, the settings row it lands on, the wire it reads back
on, and the cut that writes every round at once.

**What is deliberately absent.** ``advance()`` does not pair rounds 2..R yet — that is
the next slice — so there is no test here of a decided round producing pairings. The
absence is asserted in ``test_draws.py`` rather than papered over, because a stub would
write pairings nothing computed.
"""

import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
import pytest_asyncio
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    DrawType,
    TournamentEntry,
    TournamentEntryStatus,
    TournamentEvent,
    TournamentFixture,
    TournamentStatus,
    User,
)
from app.schemas.tournament import MAX_SWISS_ROUNDS
from app.tournament_draw_settings import draw_settings_of
from app.tournament_draws import DrawCurrency, draw_currency_by_event
from app.tournaments import TOURNAMENT_CREATE, TOURNAMENT_VIEW
from tests._helpers import grant_permissions, make_user, start_session

# The tournament suite's own lifecycle helpers, imported rather than re-declared so a
# change to how a tournament is started (or a status is staged) reaches this file too.
from tests.test_tournaments import _go_live, _set_status, _withdraw

SWISS = DrawType.swiss.value


@pytest_asyncio.fixture
async def authed_client(
    api_client: AsyncClient, db_session: AsyncSession
) -> AsyncIterator[tuple[AsyncClient, User]]:
    user = await start_session(api_client, db_session)
    await grant_permissions(db_session, user, (TOURNAMENT_VIEW, TOURNAMENT_CREATE))
    yield api_client, user


def _tournament_payload() -> dict[str, Any]:
    return {
        "name": "Swiss Open",
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
    """A swiss event of three rounds.

    **No pools**: swiss is pool-less, and sending pools an un-pooled draw type ignores
    would make every assertion below about a shape the format does not have.
    """
    payload: dict[str, Any] = {
        "name": "Open Singles",
        "format": "singles",
        "draw_type": SWISS,
        "rounds": 3,
        "max_players": 64,
        "entry_fee": 0,
        "timezone": "America/Chicago",
        "slot": {"date": "2026-06-13", "start": "09:00", "end": "18:00"},
        "match_settings": {"rated": False, "length_games": 3},
        "predicates": [],
        "pools": [],
    }
    payload.update(overrides)
    return payload


async def _tournament(client: AsyncClient) -> str:
    created = await client.post("/v1/tournaments", json=_tournament_payload())
    assert created.status_code == 201, created.text
    tournament_id: str = created.json()["id"]
    return tournament_id


async def _create_event(
    client: AsyncClient, tournament_id: str, **overrides: Any
) -> Any:
    return await client.post(
        f"/v1/tournaments/{tournament_id}/events", json=_event_payload(**overrides)
    )


async def _settings_of(db: AsyncSession, event_id: str) -> TournamentEvent:
    db.expire_all()
    return (
        await db.execute(
            select(TournamentEvent).where(TournamentEvent.id == uuid.UUID(event_id))
        )
    ).scalar_one()


def _stored_rounds(event: TournamentEvent) -> int | None:
    """The round count this event has **stored**, parsed back out of its settings row's
    JSON object (ADR "a draw type's settings are one NOT NULL JSON object")."""
    return draw_settings_of(event.draw_settings).rounds


async def _enter(
    db: AsyncSession, event_id: str, user: User, *, seed: int, minutes: int
) -> TournamentEntry:
    entry = TournamentEntry(
        event_id=uuid.UUID(event_id),
        user_id=user.id,
        status=TournamentEntryStatus.entered,
        seed=seed,
        created_at=datetime(2026, 6, 1, 9, 0, tzinfo=UTC) + timedelta(minutes=minutes),
    )
    db.add(entry)
    await db.commit()
    return entry


async def _field(
    client: AsyncClient, db: AsyncSession, size: int, **overrides: Any
) -> tuple[str, str, list[TournamentEntry]]:
    """A swiss event with a stated field of ``size`` seeded entrants, seed ``n`` being
    the ``n``-th in the draw order."""
    tournament_id = await _tournament(client)
    event_id = (await _create_event(client, tournament_id, **overrides)).json()["id"]
    entries = [
        await _enter(db, event_id, await make_user(db, f"swiss{n}"), seed=n, minutes=n)
        for n in range(1, size + 1)
    ]
    return tournament_id, event_id, entries


async def _cut(client: AsyncClient, tournament_id: str, event_id: str) -> Any:
    return await client.post(f"/v1/tournaments/{tournament_id}/events/{event_id}/draw")


async def _fixtures(db: AsyncSession, event_id: str) -> list[TournamentFixture]:
    return list(
        (
            await db.execute(
                select(TournamentFixture)
                .where(TournamentFixture.event_id == uuid.UUID(event_id))
                .order_by(TournamentFixture.round, TournamentFixture.position)
            )
        )
        .scalars()
        .all()
    )


async def _event_read(client: AsyncClient, tournament_id: str) -> dict[str, Any]:
    response = await client.get(f"/v1/tournaments/{tournament_id}")
    assert response.status_code == 200, response.text
    (event,) = response.json()["events"]
    read: dict[str, Any] = event
    return read


# ----- the request boundary: a round count belongs to exactly one draw type ----------


async def test_creating_a_swiss_event_persists_its_round_count(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    """The whole configuration lands on the settings row: the slug *and* the R.

    Asserted from the database rather than the response, because the row is what the
    cut reads — a response echoing a number nothing stored would satisfy a wire
    assertion and then cut a draw of a different length.
    """
    client, _ = authed_client
    tournament_id = await _tournament(client)

    created = await _create_event(client, tournament_id, rounds=5)

    assert created.status_code == 201, created.text
    event = await _settings_of(db_session, created.json()["id"])
    assert event.draw_settings.draw_type is DrawType.swiss
    assert _stored_rounds(event) == 5


async def test_a_swiss_event_without_a_round_count_is_422(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    """There is no defensible default. ``ceil(log2 N)`` is the convention, and deriving
    it would move the length of a day the director has already booked tables for — so
    the omission is refused at the boundary, naming the field, and no event is written.
    """
    client, _ = authed_client
    tournament_id = await _tournament(client)
    payload = _event_payload()
    del payload["rounds"]

    response = await client.post(
        f"/v1/tournaments/{tournament_id}/events", json=payload
    )

    assert response.status_code == 422, response.text
    assert "rounds" in response.text
    events = (
        await db_session.execute(
            select(TournamentEvent).where(
                TournamentEvent.tournament_id == uuid.UUID(tournament_id)
            )
        )
    ).scalars()
    assert list(events) == [], "a refusal at the boundary writes nothing"


@pytest.mark.parametrize("draw_type", ["round-robin", "single-elim", "rr-then-ko"])
async def test_a_round_count_on_another_draw_type_is_422(
    authed_client: tuple[AsyncClient, User], draw_type: str
) -> None:
    """**Refused at the boundary, never silently dropped.** "Play 3 rounds" means
    nothing to a round-robin (the circle method decides how many there are), to a
    bracket (its depth follows from the field) or to a two-stage draw (neither stage
    has a chosen count). Every other draw type is asked, because a union that had lost
    one arm's ``extra="forbid"`` would look identical on a one-slug test."""
    client, _ = authed_client
    tournament_id = await _tournament(client)

    response = await _create_event(
        client,
        tournament_id,
        draw_type=draw_type,
        rounds=3,
        **({"qualifiers_per_pool": 2} if draw_type == "rr-then-ko" else {}),
    )

    assert response.status_code == 422, response.text
    assert "rounds" in response.text


@pytest.mark.parametrize("rounds", [0, -1, MAX_SWISS_ROUNDS + 1, 2_147_483_648])
async def test_a_round_count_outside_the_static_bounds_is_422(
    authed_client: tuple[AsyncClient, User], rounds: int
) -> None:
    """``1 <= R <= MAX_SWISS_ROUNDS`` is the static half of the legal space: zero rounds
    play nothing, a negative is not a count, and the top end keeps a form value from
    walking into an ``Integer`` column as a 500. The bound that moves with the field
    (``R <= N - 1``) is deliberately not here — it is refused at the cut."""
    client, _ = authed_client
    tournament_id = await _tournament(client)

    response = await _create_event(client, tournament_id, rounds=rounds)

    assert response.status_code == 422, response.text
    assert "rounds" in response.text


async def test_a_round_count_at_the_ceiling_is_accepted(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    """The bound is **inclusive**, pinned so the refusal above cannot be satisfied by an
    off-by-one that also refuses the last legal number."""
    client, _ = authed_client
    tournament_id = await _tournament(client)

    created = await _create_event(client, tournament_id, rounds=MAX_SWISS_ROUNDS)

    assert created.status_code == 201, created.text
    event = await _settings_of(db_session, created.json()["id"])
    assert _stored_rounds(event) == MAX_SWISS_ROUNDS


async def test_the_round_count_reads_back_flat_beside_the_draw_type(
    authed_client: tuple[AsyncClient, User],
) -> None:
    """The editor has to see the stored R, because the arm requires one on every PATCH
    of a swiss event — a rename that guessed a round count would silently re-cut the
    director's day."""
    client, _ = authed_client
    tournament_id = await _tournament(client)

    created = await _create_event(client, tournament_id, rounds=4)

    assert created.json()["rounds"] == 4
    assert created.json()["qualifiers_per_pool"] is None
    read = await _event_read(client, tournament_id)
    assert read["rounds"] == 4
    assert read["draw_type"] == SWISS


async def test_another_draw_type_reads_back_no_round_count(
    authed_client: tuple[AsyncClient, User],
) -> None:
    """``null`` for every draw type that has no chosen round count — a fact, not
    missing data, and the same shape the qualifier count takes on the arms with no
    knockout stage."""
    client, _ = authed_client
    tournament_id = await _tournament(client)

    created = await _create_event(
        client, tournament_id, draw_type="round-robin", rounds=None
    )

    assert created.status_code == 201, created.text
    assert created.json()["rounds"] is None


async def test_patching_a_round_count_without_its_draw_type_is_422(
    authed_client: tuple[AsyncClient, User],
) -> None:
    """The draw configuration is patched **as a unit**, exactly as the qualifier count
    is: which draw types carry a round count is a fact about the pair, and a patch
    carrying only ``rounds`` does not hold it."""
    client, _ = authed_client
    tournament_id = await _tournament(client)
    event_id = (await _create_event(client, tournament_id)).json()["id"]

    response = await client.patch(
        f"/v1/tournaments/{tournament_id}/events/{event_id}",
        json={"rounds": 5},
    )

    assert response.status_code == 422, response.text
    assert "draw_type" in response.text


async def test_patching_away_from_swiss_clears_the_round_count(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    """The pair is written together, so a draw type moved to round-robin leaves no
    round count behind — and the wire says so, or the editor re-sends a number the
    boundary now refuses."""
    client, _ = authed_client
    tournament_id = await _tournament(client)
    event_id = (await _create_event(client, tournament_id)).json()["id"]

    response = await client.patch(
        f"/v1/tournaments/{tournament_id}/events/{event_id}",
        json={"draw_type": "round-robin"},
    )

    assert response.status_code == 200, response.text
    assert response.json()["rounds"] is None
    event = await _settings_of(db_session, event_id)
    assert _stored_rounds(event) is None


# ----- the cut: every round at once --------------------------------------------------


async def test_the_cut_writes_every_round_with_round_one_seated(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    """Eight entrants, three rounds: 12 fixtures, cut in one stroke.

    Round 1 carries both sides, seeded from the draw order — top half against bottom
    half, so seed 1 meets seed 5. Rounds 2 and 3 exist with both sides NULL, which
    means TBD and nothing else (ADR-0786). Every fixture is un-pooled, because swiss
    ranks one field in one table.
    """
    client, _ = authed_client
    tournament_id, event_id, entries = await _field(client, db_session, 8)

    assert (await _cut(client, tournament_id, event_id)).status_code == 201

    fixtures = await _fixtures(db_session, event_id)
    assert len(fixtures) == 12
    assert all(f.pool_id is None for f in fixtures)

    by_seed = {entry.seed: entry.id for entry in entries}
    round_one = [f for f in fixtures if f.round == 1]
    assert [(f.position, f.entry_a_id, f.entry_b_id) for f in round_one] == [
        (1, by_seed[1], by_seed[5]),
        (2, by_seed[2], by_seed[6]),
        (3, by_seed[3], by_seed[7]),
        (4, by_seed[4], by_seed[8]),
    ]

    later = [f for f in fixtures if f.round > 1]
    assert sorted((f.round, f.position) for f in later) == [
        (2, 1),
        (2, 2),
        (2, 3),
        (2, 4),
        (3, 1),
        (3, 2),
        (3, 3),
        (3, 4),
    ]
    assert all(f.entry_a_id is None and f.entry_b_id is None for f in later)


async def test_an_odd_field_cuts_one_fewer_pairing_a_round(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    """Seven entrants, two rounds: three pairings a round, and the entrant sitting out
    has **no fixture** — a bye is the absence of a row, never a row with a NULL side
    (CONTEXT.md, "Bye"). Which entrant that is, round by round, is the next slice's
    problem; in round 1, with nobody yet on a score, it is the lowest seed."""
    client, _ = authed_client
    tournament_id, event_id, entries = await _field(client, db_session, 7, rounds=2)

    assert (await _cut(client, tournament_id, event_id)).status_code == 201

    fixtures = await _fixtures(db_session, event_id)
    assert len(fixtures) == 6
    round_one = [f for f in fixtures if f.round == 1]
    seated = {f.entry_a_id for f in round_one} | {f.entry_b_id for f in round_one}
    by_seed = {entry.seed: entry.id for entry in entries}
    assert seated == {by_seed[seed] for seed in range(1, 7)}
    assert by_seed[7] not in seated


async def test_the_standings_carry_the_whole_field_including_the_byed_entrant(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    """A cut swiss event reads out as one pool-less table over **every** entrant.

    Seven entrants means one of them has no round-1 fixture at all — a bye is the
    absence of a row — so a table derived from the fixtures' sides would seat six and
    quietly leave the seventh off the standings they are entitled to a row on. The
    field comes off the event's entrants for exactly that reason.
    """
    client, _ = authed_client
    tournament_id, event_id, entries = await _field(client, db_session, 7, rounds=2)
    assert (await _cut(client, tournament_id, event_id)).status_code == 201

    results = (await _event_read(client, tournament_id))["results"]

    assert results["kind"] == "swiss_standings"
    assert {row["entry_id"] for row in results["rows"]} == {
        str(entry.id) for entry in entries
    }
    assert [row["rank"] for row in results["rows"]] == [1, 2, 3, 4, 5, 6, 7]
    assert all(row["played"] == 0 for row in results["rows"]), "nobody has played yet"
    assert results["complete"] is False
    assert results["champion"] is None


async def test_cutting_more_rounds_than_the_field_has_opponents_is_refused(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    """A moving bound, refused at the cut in the director's own language, naming both
    ways out — and nothing is written.

    It cannot live at the request boundary: it depends on the entrant count, which
    moves. A round count that was legal when it was written must not become unwritable
    because a player withdrew.
    """
    client, _ = authed_client
    tournament_id, event_id, _ = await _field(client, db_session, 5, rounds=9)

    response = await _cut(client, tournament_id, event_id)

    assert response.status_code == 422, response.text
    assert response.json()["detail"] == (
        "9 rounds is more than the 4 opponents each of 5 entrants can have — play "
        "fewer rounds, or add entrants."
    )
    assert await _fixtures(db_session, event_id) == [], (
        "a refused cut writes nothing at all"
    )


async def test_the_round_count_is_frozen_once_the_draw_is_cut(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    """409, exactly as the draw type freezes, and for the same concrete reason: every
    round's fixtures are already rows in the database, so raising R would leave the
    added rounds with none and lowering it would leave fixtures no round claims."""
    client, _ = authed_client
    tournament_id, event_id, _ = await _field(client, db_session, 8)
    assert (await _cut(client, tournament_id, event_id)).status_code == 201

    response = await client.patch(
        f"/v1/tournaments/{tournament_id}/events/{event_id}",
        json={"draw_type": SWISS, "rounds": 5},
    )

    assert response.status_code == 409, response.text
    assert "rounds is frozen" in response.json()["detail"]
    event = await _settings_of(db_session, event_id)
    assert _stored_rounds(event) == 3, "a refusal wrote nothing"


async def test_the_round_count_is_editable_while_no_draw_exists(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    """The freeze above is about a **cut** draw. Before one, the round count is ordinary
    editable configuration — without this the 409 test could pass against a rule that
    refused every change."""
    client, _ = authed_client
    tournament_id = await _tournament(client)
    event_id = (await _create_event(client, tournament_id)).json()["id"]

    response = await client.patch(
        f"/v1/tournaments/{tournament_id}/events/{event_id}",
        json={"draw_type": SWISS, "rounds": 6},
    )

    assert response.status_code == 200, response.text
    assert response.json()["rounds"] == 6
    event = await _settings_of(db_session, event_id)
    assert _stored_rounds(event) == 6


# ----- draw currency: a byed entrant is covered, a latecomer is not ------------------


async def _currency(db: AsyncSession, event_id: str) -> DrawCurrency:
    """Where this event's draw stands relative to its field — read through the same
    loader the go-live precondition asks."""
    event_uuid = uuid.UUID(event_id)
    db.expire_all()
    return (await draw_currency_by_event(db, [event_uuid]))[event_uuid]


async def test_an_odd_swiss_field_reads_current_and_can_go_live(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    """**A bye is not a missing player.** Seven entrants across two rounds means one of
    them sits out round 1, and a bye is the absence of a fixture row — so the byed
    entrant is seated in no fixture at all.

    Currency compares the fixtures' seated entries against the active ones, and that
    comparison read the bye as an entrant the draw had failed to cover: the draw came
    back ``stale`` and go-live answered 409 for an odd field that had just been cut
    from exactly those entrants. Nothing a director could do would clear it — re-cutting
    deals the same bye — so an odd-field swiss event could be configured, entered and
    cut, and then never start.
    """
    client, _ = authed_client
    tournament_id, event_id, _ = await _field(client, db_session, 7, rounds=2)
    assert (await _cut(client, tournament_id, event_id)).status_code == 201
    await _set_status(db_session, tournament_id, TournamentStatus.published)

    assert await _currency(db_session, event_id) is DrawCurrency.current

    started = await _go_live(client, tournament_id)
    assert started.status_code == 201, started.text


async def test_a_swiss_draw_is_stale_when_an_entry_lands_after_the_cut(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    """The check the bye must not blunt: somebody entered after the cut.

    Seven entrants are cut (six seated, one byed) and an eighth arrives. Two of the
    eight are now seated nowhere, which is one more than a single round's bye can
    account for — so the draw is stale and the director is told to cut it again, exactly
    as they would be for a round-robin.
    """
    client, _ = authed_client
    tournament_id, event_id, _ = await _field(client, db_session, 7, rounds=2)
    assert (await _cut(client, tournament_id, event_id)).status_code == 201
    await _set_status(db_session, tournament_id, TournamentStatus.published)
    await _enter(
        db_session,
        event_id,
        await make_user(db_session, "swiss-latecomer"),
        seed=8,
        minutes=8,
    )

    assert await _currency(db_session, event_id) is DrawCurrency.stale

    refused = await _go_live(client, tournament_id)
    assert refused.status_code == 409, refused.text
    assert "no longer matches its entrants" in refused.json()["detail"]


async def test_a_swiss_draw_is_stale_when_a_seated_entrant_withdraws(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    """The other direction, and the one a bye allowance must not swallow: the draw seats
    somebody who has **left**. An entry the fixtures still name is not covered by "one
    entrant may be unseated" — it is the opposite complaint, and it stays a 409."""
    client, _ = authed_client
    tournament_id, event_id, entries = await _field(client, db_session, 8, rounds=2)
    assert (await _cut(client, tournament_id, event_id)).status_code == 201
    await _set_status(db_session, tournament_id, TournamentStatus.published)
    await _withdraw(db_session, entries[0])

    assert await _currency(db_session, event_id) is DrawCurrency.stale

    refused = await _go_live(client, tournament_id)
    assert refused.status_code == 409, refused.text


async def test_two_late_entries_exhaust_the_bye_allowance_and_are_stale(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    """The allowance is **one** entrant, not "swiss stopped checking": eight are cut and
    two more arrive, so two of the ten are seated nowhere and no single round's bye can
    account for them."""
    client, _ = authed_client
    tournament_id, event_id, _ = await _field(client, db_session, 8, rounds=2)
    assert (await _cut(client, tournament_id, event_id)).status_code == 201
    await _set_status(db_session, tournament_id, TournamentStatus.published)
    for n in (9, 10):
        await _enter(
            db_session,
            event_id,
            await make_user(db_session, f"swiss-late-{n}"),
            seed=n,
            minutes=n,
        )

    assert await _currency(db_session, event_id) is DrawCurrency.stale
    assert (await _go_live(client, tournament_id)).status_code == 409


async def test_a_lone_latecomer_leaving_an_odd_field_reads_as_that_rounds_bye(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    """**The known limit of the allowance, pinned rather than left to be discovered.**

    Eight entrants are cut and a ninth arrives. That draw holds exactly the rows a draw
    cut for nine holds — ⌊8/2⌋ and ⌊9/2⌋ are the same four fixtures a round, and the
    byed entrant of a nine-player cut is recorded nowhere either. So the two states are
    indistinguishable, and this one reads ``current``: the latecomer is treated as the
    entrant sitting round 1 out.

    The direction of the error is deliberate. On swiss it costs the newcomer a bye,
    which the format hands somebody every odd round anyway. It is *not* a licence taken
    for the other draw types, where an unseated entrant would play no match at all: the
    test above them still shows a round-robin refusing the identical movement of the
    field, and ``test_two_late_entries_exhaust_the_bye_allowance_and_are_stale`` shows
    the allowance stops at one.
    """
    client, _ = authed_client
    tournament_id, event_id, _ = await _field(client, db_session, 8, rounds=2)
    assert (await _cut(client, tournament_id, event_id)).status_code == 201
    await _set_status(db_session, tournament_id, TournamentStatus.published)
    await _enter(
        db_session,
        event_id,
        await make_user(db_session, "swiss-ninth"),
        seed=9,
        minutes=9,
    )

    assert await _currency(db_session, event_id) is DrawCurrency.current
    assert (await _go_live(client, tournament_id)).status_code == 201


async def test_a_swiss_event_has_no_schedule_preview(
    authed_client: tuple[AsyncClient, User], db_session: AsyncSession
) -> None:
    """The preview covers the **pool stage**, and swiss has no pools — so a director
    asking for one is told the format has no preview rather than shown an empty day
    (ADR). The pure refusal is asserted in ``test_schedule_preview_snapshot.py``; this
    is that refusal reaching the director as a 422 rather than a 500."""
    client, _ = authed_client
    tournament_id, _, _ = await _field(client, db_session, 8)

    response = await client.post(f"/v1/tournaments/{tournament_id}/schedule/preview")

    assert response.status_code == 422, response.text
    assert SWISS in response.text

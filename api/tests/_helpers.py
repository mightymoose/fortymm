"""Shared test helpers for the API test suite.

The leading underscore keeps pytest from auto-collecting this as a test module;
fixtures still belong in ``conftest.py``.
"""

import uuid
from collections.abc import AsyncIterator, Callable, Mapping, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import date, time
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient, Request
from rq import Queue
from sqlalchemy import Select, event, select, text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from app import schedule_solves, scheduling
from app.geocoding import FakeGeocoder, GeocodeResult
from app.main import app as fastapi_app
from app.models import (
    DrawType,
    League,
    Permission,
    RatingHistory,
    RatingHistorySource,
    Role,
    RolePermission,
    Tournament,
    TournamentEvent,
    TournamentEventDrawSettings,
    TournamentEventGroupReservation,
    TournamentEventReservation,
    TournamentEventReservationTable,
    TournamentEventStage,
    TournamentEventStageGroup,
    User,
    UserLeagueRating,
    UserRole,
    VenueTable,
)
from app.notifications.apns import Environment, SendOutcome, SendResult
from app.notifications.dependencies import get_push_sender
from app.notifications.jobs import DELIVER_NOTIFICATION_JOB
from app.scheduling import ScheduleSnapshot, SolveResult
from app.schemas.notification import NotificationJob
from app.schemas.tournament import draw_settings_from_storage
from app.sessions import CSRF_COOKIE_NAME, CSRF_HEADER_NAME, CSRF_SAFE_METHODS
from app.tournament_draw_settings import draw_settings_row


def hijack_solve(
    monkeypatch: pytest.MonkeyPatch, after_solve: Callable[[], None]
) -> None:
    """Interpose on the ``_solve`` seam: run the real solver, then
    ``after_solve`` — landing work exactly in the gap between a schedule
    solve job's snapshot and its guarded apply (the drift-guard race
    window)."""
    real = scheduling.solve

    def wrapper(
        snapshot: ScheduleSnapshot, time_cap_s: float, num_search_workers: int
    ) -> SolveResult:
        result = real(
            snapshot, time_cap_s=time_cap_s, num_search_workers=num_search_workers
        )
        after_solve()
        return result

    monkeypatch.setattr(schedule_solves, "_solve", wrapper)


def enqueued_notification_jobs(queue: Queue) -> list[NotificationJob]:
    """The notification-delivery payloads enqueued so far, decoded back into
    ``NotificationJob``. Under the async-style ``fake_notifications_queue`` the
    worker body never runs, so tests assert on what was enqueued; channel
    delivery itself is covered by the ``NotificationService.notify`` tests."""
    jobs: list[NotificationJob] = []
    for job in queue.get_jobs():
        assert job.func_name == DELIVER_NOTIFICATION_JOB
        jobs.append(NotificationJob.model_validate_json(job.args[0]))
    return jobs


async def _attach_csrf_header(request: Request) -> None:
    """httpx request hook that satisfies the app's double-submit CSRF guard on
    every mutating request, mirroring the browser client.

    If the client carries a real ``csrf_token`` cookie (it called
    ``/v1/session``), echo that value in the ``X-CSRF-Token`` header. Tests that
    bypass the session via ``dependency_overrides`` have no such cookie, so
    inject a synthetic matching cookie/header pair — they still need to clear
    the middleware. Tests exercising the *rejection* path build a client
    without this hook."""
    if request.method.upper() in CSRF_SAFE_METHODS:
        return
    cookie_header = request.headers.get("cookie")
    prefix = f"{CSRF_COOKIE_NAME}="
    token: str | None = None
    for part in (cookie_header or "").split("; "):
        if part.startswith(prefix):
            token = part[len(prefix) :]
            break
    if token is None:
        token = "test-csrf-token"
        pair = f"{prefix}{token}"
        request.headers["cookie"] = (
            f"{cookie_header}; {pair}" if cookie_header else pair
        )
    request.headers[CSRF_HEADER_NAME] = token


# Pass to every test ``AsyncClient`` so the existing mutating-request tests keep
# passing under the double-submit CSRF guard.
CSRF_EVENT_HOOKS = {"request": [_attach_csrf_header]}


async def start_session(api_client: AsyncClient, db_session: AsyncSession) -> User:
    """Establish a session cookie on the client and return the signed-in user."""
    response = await api_client.get("/v1/session")
    assert response.status_code == 200
    username = response.json()["data"]["user"]["username"]
    return (
        await db_session.execute(select(User).where(User.username == username))
    ).scalar_one()


async def make_user(db_session: AsyncSession, username: str) -> User:
    user = User(username=username)
    db_session.add(user)
    await db_session.commit()
    await db_session.refresh(user)
    return user


def venue_tables(*specs: tuple[str, str]) -> list[VenueTable]:
    """Catalogue rows — ``(label, court)`` pairs — for a tournament a test seeds
    straight through the ORM, positioned in the order given.

    The ids are minted **here**, up front, rather than left to the column's
    ``gen_random_uuid()`` default, for one reason: a pool's ``table_ids`` and a
    fixture's ``table_id`` name a table by id, so a test that seeds a placement needs
    the id before the row is flushed. Fresh ``uuid4``s per call, never module
    constants — the id is a primary key, so two tournaments in one test cannot share
    one.

    Through the API the ids are the *server's* and there is no ``id`` on the write
    shape at all (ADR 20260801); this is the direct-to-database seam, which no HTTP
    caller can reach.
    """
    return [
        VenueTable(id=uuid.uuid4(), label=label, court=court, position=position)
        for position, (label, court) in enumerate(specs)
    ]


def event_draw_settings(
    draw_type: DrawType,
    *,
    qualifiers_per_pool: int | None = None,
    rounds: int | None = None,
) -> TournamentEventDrawSettings:
    """The draw-settings row for an event a test seeds straight through the ORM, built
    from the draw type and whichever setting that draw type carries — the qualifier
    count for ``rr-then-ko``, the round count for ``swiss``.

    Neither is a column any more — both are keys inside the row's ``settings`` JSON
    object (ADR "a draw type's settings are one NOT NULL JSON object") — so this is the
    one translation from the values the tests speak to the stored shape, and it goes
    through the same parse and the same writer the request boundary uses. Which means a
    seed that names a count for a draw type that has no such setting (or omits one a
    draw type requires) reds here with a ``ValidationError``, rather than writing a row
    the app could not have made.

    Both ``None`` is "this draw type takes no configuration", and it stores ``{}``.
    """
    settings: dict[str, int] = {}
    if qualifiers_per_pool is not None:
        settings["qualifiers_per_pool"] = qualifiers_per_pool
    if rounds is not None:
        settings["rounds"] = rounds
    return draw_settings_row(draw_settings_from_storage(draw_type, settings))


def event_pools(
    pools: Sequence[Mapping[str, Any]],
    *,
    event: TournamentEvent,
    tournament: Tournament | None = None,
) -> list[TournamentEventStageGroup]:
    """The GROUP rows — each already mapped to its own reservation — for an event a test
    seeds straight through the ORM, written from the ``{id, name, slot, table_ids}``
    dict shape the pools JSONB used to hold and positioned in the order given.

    What the wire calls a pool is two rows: a
    :class:`~app.models.tournament_event_stage_group.TournamentEventStageGroup`
    (identity and order, parented on a stage) and a
    :class:`~app.models.tournament_event_reservation.TournamentEventReservation` (the
    name, the window and the tables, parented on the event), joined by a
    :class:`~app.models.tournament_event_group_reservation.TournamentEventGroupReservation`.
    This helper builds all three from one dict, exactly as
    ``app.tournament_pools.stored_pools`` does from one payload entry, so a seeded pool
    and a POSTed one are the same rows — and so a seed cannot accidentally create the
    group-without-reservation state no application path produces.

    It returns the **groups**, with the reservations riding along inside them, so the
    caller assigns one collection and gets the whole graph:
    ``stages[0].groups = event_pools(..., event=event)``, mirroring
    ``app.tournament_events.create_event``. Each reservation's ``event`` relationship is
    set to ``event``, which populates its ``event_id`` at flush even when ``event`` has
    no id yet.

    The ``slot``'s ``YYYY-MM-DD`` / ``HH:MM`` strings are parsed into the reservation's
    ``slot_date`` / ``slot_start`` / ``slot_end`` columns exactly as the write boundary
    parses them.

    The ``id`` is a ``uuid.UUID`` and is **optional**, and it is the **group's** — the
    id a fixture's ``pool_id`` holds and the id the wire serves. Pass one when the test
    needs to name the pool from somewhere else (a fixture's ``pool_id``, an assertion),
    and leave it out when it does not care. A minted ``uuid4`` per call, never a module
    constant — the id is a primary key, so two events in one test cannot share one.
    Minted *here*, up front, rather than left to the column's ``gen_random_uuid()``
    default, for the reason :func:`venue_tables` mints table ids: a seed that names the
    group needs the id before the row is flushed. Through the API the ids are the
    *server's* and there is no ``id`` on the create shape at all (ADR 20260801); this is
    the direct-to-database seam, which no HTTP caller can reach.

    A reservation's ``table_ids`` become
    :class:`~app.models.tournament_event_reservation_table.TournamentEventReservationTable`
    **rows** (ADR 20260801), so naming any table needs the ``tournament`` — twice over.
    It supplies the alias map, rewriting the positional aliases a test writes (``"t1"``,
    ``"t2"``, …) into the real ids of that tournament's catalogue rows (1-based, in
    catalogue order), because a table id is a server-minted UUID a seed cannot spell as
    a literal. And it supplies the ``tournament_id`` every row carries — the
    denormalized column the composite foreign keys compare, without which the row is not
    one Postgres accepts. It must already be flushed, since that id is the database's to
    mint.

    Naming a table with no ``tournament`` is a ``ValueError`` rather than a silently
    empty table list: a seed that means "this pool runs on two tables" and gets one
    running on none would go on passing while testing something else. (A pool with no
    ``table_ids`` at all needs no tournament, which is most of the suite.)
    """
    by_alias = (
        {
            f"t{position}": str(table.id)
            for position, table in enumerate(tournament.tables, start=1)
        }
        if tournament is not None
        else {}
    )
    groups: list[TournamentEventStageGroup] = []
    for position, pool in enumerate(pools):
        slot = pool.get("slot") or {}
        table_ids = [str(table_id) for table_id in pool.get("table_ids", [])]
        name = pool.get("name", f"Pool {position + 1}")
        if table_ids and tournament is None:
            raise ValueError(
                f"pool {name!r} reserves {table_ids} but no tournament was "
                "given: a reservation is a row carrying the tournament's id, so the "
                "seed has to say which tournament's tables these are — pass "
                "tournament=… (or with_table_aliases(tournament, pools))"
            )
        reservation = TournamentEventReservation(
            name=name,
            position=pool.get("position", position),
            slot_date=date.fromisoformat(slot.get("date", "2026-06-13")),
            slot_start=time.fromisoformat(slot.get("start", "09:00")),
            slot_end=time.fromisoformat(slot.get("end", "18:00")),
            event=event,
            tables=_reservation_tables(event, tournament, table_ids, by_alias),
        )
        groups.append(
            TournamentEventStageGroup(
                id=pool.get("id") or uuid.uuid4(),
                position=pool.get("position", position),
                reservation_link=TournamentEventGroupReservation(
                    reservation=reservation
                ),
            )
        )
    return groups


def _reservation_tables(
    event: TournamentEvent,
    tournament: Tournament | None,
    table_ids: Sequence[str],
    by_alias: Mapping[str, str],
) -> list[TournamentEventReservationTable]:
    """The rows one seeded reservation's ``table_ids`` become, aliases resolved and
    positioned in the order given.

    Unlike the write path (``app.tournament_pools._reservation_tables``), an id that no
    catalogue row holds is **not** dropped — it is passed through to the database, which
    refuses it. This is the direct-to-database seam, and a seed that names a table this
    tournament does not have is a mistake in the seed; swallowing it here would hide the
    very foreign keys these rows exist to have.
    """
    if tournament is None:
        return []
    return [
        TournamentEventReservationTable(
            tournament_id=tournament.id,
            table_id=by_alias.get(table_id, table_id),
            position=position,
            event=event,
        )
        for position, table_id in enumerate(table_ids)
    ]


def with_table_aliases(
    event: TournamentEvent,
    tournament: Tournament,
    pools: Sequence[Mapping[str, Any]],
) -> list[TournamentEventStageGroup]:
    """:func:`event_pools` with the event and tournament bound — the spelling the seeds
    that name tables already use.

    Kept as its own name because it is what the call sites are *about*: "these pools
    reserve this tournament's first two tables", said without threading a UUID through
    every helper the pools are passed to.
    """
    return event_pools(pools, event=event, tournament=tournament)


def joined_to_reservation(stmt: Select[Any]) -> Select[Any]:
    """``stmt``, joined from :class:`TournamentEventStageGroup` through to its
    :class:`TournamentEventReservation` — the one place the group→reservation walk is
    spelled in the suite.

    What the wire calls one pool is two rows joined by a third, so any assertion about
    a pool's NAME or WINDOW keyed by the id a fixture holds has to walk that path. Seven
    call sites across four test files had written it out by hand, each restating ON
    clauses the relationships already carry.

    Joined through the **relationships** rather than by explicit ``onclause``, so the
    foreign-key topology lives in the models and nowhere else: renaming a column breaks
    one place instead of silently changing what seven joins mean.

    It is one function rather than seven for a reason that is not tidiness. These are
    INNER joins, and they are correct only while every group has a reservation. The
    moment a group may exist without one, every one of them silently drops rows instead
    of failing — and the fix is ``.outerjoin`` in exactly one place if this helper is
    used, or a hunt through four files if it is not.

    Usage::

        rows = await db.execute(
            joined_to_reservation(
                select(TournamentEventStageGroup.id, TournamentEventReservation.name)
            ).where(TournamentEventStageGroup.stage_id == stage_id)
        )
    """
    return stmt.join(TournamentEventStageGroup.reservation_link).join(
        TournamentEventGroupReservation.reservation
    )


async def stage_id_at(
    db_session: AsyncSession, event_id: uuid.UUID, position: int
) -> uuid.UUID:
    """The id of ``event_id``'s stage at ``position`` — the awaited, single-stage
    counterpart of ``app.tournament_queries.stage_ids_for_events`` (which returns an
    unawaited ``.in_(...)``-embeddable subquery over *every* stage of one or more
    events, not one stage by position).

    Position 0 is the one a director's pools hang off (ADR 20260815 decision 3);
    position 1 is the knockout half of an rr-then-ko template. ``scalar_one()``, not
    ``scalar_one_or_none()``: every event holds its minted stages from the moment it
    exists, so a miss here is a test-fixture bug (an event seeded straight through the
    ORM, bypassing ``create_event``/``mint_stages``), not a state worth tolerating
    silently.
    """
    return (
        await db_session.execute(
            select(TournamentEventStage.id).where(
                TournamentEventStage.event_id == event_id,
                TournamentEventStage.position == position,
            )
        )
    ).scalar_one()


async def table_ids_of(db_session: AsyncSession, tournament_id: uuid.UUID) -> list[str]:
    """The tournament's venue-table ids, as strings, in its own catalogue order.

    Read from ``tournament_tables`` rather than off an ORM instance, so it is safe
    after the commits and ``expire_all``s these suites do between acting and
    asserting. Tests unpack it (``table_1, table_2 = await table_ids_of(...)``) where
    they used to write the literal ``"t1"``: the id is a server-minted UUID now
    (ADR 20260801), so a placement or a pool has to be told which one it means.
    """
    return [
        str(table_id)
        for table_id in (
            await db_session.execute(
                select(VenueTable.id)
                .where(VenueTable.tournament_id == tournament_id)
                .order_by(VenueTable.position)
            )
        )
        .scalars()
        .all()
    ]


async def assert_tournament_address_is_sql_null(
    db_session: AsyncSession, tournament_id: uuid.UUID
) -> None:
    """Assert **at the SQL level** that a tournament's ``address`` is a true SQL NULL,
    and specifically not the JSONB ``null`` literal.

    ``row.address is None`` cannot make this distinction and must not be trusted for it.
    A JSONB column deserializes *both* encodings into Python ``None``, so an ORM-level
    identity check is green either way — which is exactly how ``tournaments.address``
    came to store the ``'null'`` literal on every app-written no-venue row while the
    comments around it, and a docstring claiming the value "must reach the column as SQL
    NULL", all said otherwise. The cost of that divergence is that
    ``Tournament.address.is_(None)`` matched **zero** of them, silently. Postgres is the
    only witness that can tell them apart:

    ==================  =============  ===========================
    stored value        ``IS NULL``    ``jsonb_typeof(address)``
    ==================  =============  ===========================
    SQL NULL            ``True``       SQL NULL → Python ``None``
    JSONB ``'null'``    ``False``      ``'null'``
    ==================  =============  ===========================

    Both are asserted together so a failure names *which* encoding was found rather than
    merely "not null".
    """
    sql_null, json_type = (
        await db_session.execute(
            text(
                "SELECT address IS NULL, jsonb_typeof(address) "
                "FROM tournaments WHERE id = :id"
            ),
            {"id": tournament_id},
        )
    ).one()
    assert (sql_null, json_type) == (True, None), (
        f"tournaments.address is not a SQL NULL: IS NULL={sql_null}, "
        f"jsonb_typeof={json_type!r} — jsonb_typeof='null' means the column holds the "
        "JSON null *literal*, i.e. Tournament.address has lost none_as_null=True and "
        "'no venue' again has two stored representations (#1206)"
    )


class CountingGeocoder:
    """A ``Geocoder`` that records how many times it was asked to geocode, delegating to
    the deterministic ``FakeGeocoder`` so results stay stable.

    Structurally satisfies the ``Geocoder`` protocol, so it is injected exactly where
    the real geocoder would be. Shared by the create- and edit-verb tests because that
    protocol is *structural*: a second copy of this double could go on satisfying an
    older shape of ``Geocoder.geocode`` with nothing to point at it.

    The call count is what lets a test assert something no status code can — that a
    write geocoded, or did not. Each caller's reason for caring is a comment on the
    tests that use it.
    """

    def __init__(self) -> None:
        self.calls = 0
        self._inner = FakeGeocoder()

    async def geocode(self, address: str) -> GeocodeResult:
        self.calls += 1
        return await self._inner.geocode(address)


#: The six free-text components of the venue value-object, named once so an all-blank
#: address is built from the shape rather than by hand — and so a seventh component
#: cannot be added without every all-blank test blanking it too.
ADDRESS_COMPONENTS = ("venue", "street", "city", "region", "postal", "country")

#: Parametrizes ``blank`` over the two all-blank address gestures a web form can make:
#: six empty strings, and six whitespace-only strings (a stray space in one of six boxes
#: is not a venue). Shared by the schema boundary tests and both write verbs' tests, so
#: "all blank means no venue" is pinned from the same one definition of "all blank".
#:
#: ``strict=True`` on the zip is deliberate: add a seventh component to
#: ``ADDRESS_COMPONENTS`` and this raises at collection rather than quietly leaving the
#: new component un-blanked — the failure mode the ids "six-empty-strings" would
#: otherwise keep cheerfully claiming was covered.
blank_addresses = pytest.mark.parametrize(
    "blank",
    [
        dict.fromkeys(ADDRESS_COMPONENTS, ""),
        dict(zip(ADDRESS_COMPONENTS, (" ", "\t", "\n", "  ", " ", " "), strict=True)),
    ],
    ids=["six-empty-strings", "whitespace-only"],
)


async def grant_permissions(
    db_session: AsyncSession, user: User, names: Sequence[str]
) -> None:
    """Grant ``names`` to ``user`` through real RBAC rows, so tests exercise the
    genuine permission gate rather than overriding it.

    Each Permission row is reused if an earlier call already created it, and the
    user gets a role of their own carrying exactly ``names`` — so two users in
    one test can hold different subsets (view-only vs view+enter, say), which is
    what proves a route is gated on the permission it claims and not merely on
    "is signed in".
    """
    role = Role(name=f"grant-{user.id}", description="Per-user test grant.")
    db_session.add(role)
    await db_session.flush()
    for name in names:
        permission = (
            await db_session.execute(select(Permission).where(Permission.name == name))
        ).scalar_one_or_none()
        if permission is None:
            permission = Permission(name=name, description=name)
            db_session.add(permission)
            await db_session.flush()
        db_session.add(RolePermission(role_id=role.id, permission_id=permission.id))
    db_session.add(UserRole(user_id=user.id, role_id=role.id))
    await db_session.commit()


async def rate_player(
    db_session: AsyncSession, user: User, league: League, value: float
) -> None:
    """Put ``user`` on ``league``'s ladder at ``value`` — **actually rated**, not merely
    holding a rating row.

    The two are different, and the difference is what keeps the Unrated tests from
    being vacuous. Minting a session JOINS the default league, which SEEDS a
    ``user_league_ratings`` row at 1500 plus an ``initial`` rating-history event
    (``app.ratings.rated``): every player in the suite already has a rating *row* on
    the default league before they do anything. So a rating is made here in the two
    moves that ``app.ratings.rated.is_rated_member`` actually asks about:

    1. the seeded row's value is MOVED to ``value`` (inserted, if this is a league the
       player never joined), and
    2. a NON-``initial`` ``rating_history`` row is written — the thing that says
       something real moved it.

    Write only (1) and the player is still Unrated by every read on the platform, and
    an "over the cap is refused" test goes green against a guard that refuses nobody.

    Shared by the eligibility tests on BOTH sides of ADR-0783 — the entry route's
    refusal (``test_tournament_entries``) and the detail read's ``entry_state``
    (``test_tournaments``) — precisely because a second, subtly weaker copy of it in
    one of them would let that side pass while testing nothing.
    """
    rating = (
        await db_session.execute(
            select(UserLeagueRating).where(
                UserLeagueRating.league_id == league.id,
                UserLeagueRating.user_id == user.id,
            )
        )
    ).scalar_one_or_none()
    if rating is None:
        rating = UserLeagueRating(
            league_id=league.id,
            user_id=user.id,
            rating_strategy_id=league.rating_strategy_id,
        )
        db_session.add(rating)
    rating.rating_value = value
    db_session.add(
        RatingHistory(
            league_id=league.id,
            user_id=user.id,
            match_id=None,
            rating_strategy_id=league.rating_strategy_id,
            rating_value=value,
            rating_state={"rating": value, "rd": 200.0, "volatility": 0.06},
            previous_rating_value=None,
            # ``manual``, not ``initial``: an ``initial`` row is the seed every member
            # joins with, and it makes nobody rated.
            source=RatingHistorySource.manual,
        )
    )
    await db_session.commit()


def make_client() -> AsyncClient:
    """Build a second cookie-isolated client bound to the same test app.

    Useful when a test needs two distinct users (each one calls
    ``start_session`` on their own client) sharing the same ``db_session``
    fixture override — which the primary ``api_client`` fixture has already
    installed by the time this helper runs.
    """
    return AsyncClient(
        transport=ASGITransport(app=fastapi_app),
        base_url="https://testserver",
        event_hooks=CSRF_EVENT_HOOKS,
    )


def make_raw_client() -> AsyncClient:
    """Like ``make_client`` but *without* the CSRF auto-attach hook, so a test
    can drive the double-submit guard by hand — or stand in for a cold,
    cookieless browser that was never issued session/csrf cookies."""
    return AsyncClient(
        transport=ASGITransport(app=fastapi_app),
        base_url="https://testserver",
    )


async def accept_standing_result(
    client: AsyncClient, match_id: str, *, expected_status: int = 201
) -> dict:
    """Accept the match's current standing proposal as ``client`` — the second
    verb of the propose/accept negotiation. Reads the standing result id from
    the match-details negotiation block, then POSTs the acceptance.

    Replaces the old ``POST /confirmation`` for the common "opponent ratifies
    the posted result" path in collateral tests."""
    details = (await client.get(f"/v1/matches/{match_id}")).json()
    standing = details["negotiation"]["standing_result"]
    assert standing is not None, "no standing result to accept"
    response = await client.post(
        f"/v1/matches/{match_id}/results/{standing['id']}/acceptance"
    )
    assert response.status_code == expected_status, response.text
    return response.json()


@asynccontextmanager
async def opponent_session(
    db_session: AsyncSession, username: str
) -> AsyncIterator[tuple[AsyncClient, User]]:
    """Async context manager that mints an ephemeral session on a fresh
    client, renames the auto-generated user to ``username``, yields
    ``(client, user)``, and closes the client on exit.

    Used by signature-flow tests that need a second human who can act on the
    match — typically ``POST /v1/matches/{id}/confirmation`` — without the
    test setting up (and cleaning up) the session juggling itself.

    Example::

        async with opponent_session(db_session, "rival") as (opp_client, opp):
            await _play_match_to_completion(
                api_client, opp_client, opp.id, best_of=3, side_1_wins=True
            )
    """
    client = make_client()
    try:
        user = await start_session(client, db_session)
        user.username = username
        await db_session.commit()
        yield client, user
    finally:
        await client.aclose()


@asynccontextmanager
async def counted_statements(
    engine: AsyncEngine,
) -> AsyncIterator[tuple[AsyncSession, list[str]]]:
    """Yields ``(session, statements)``: a session whose every emitted SQL
    statement is appended to the list, for the N+1 tripwires that pin how many
    round-trips a loader costs.

    Example::

        async with counted_statements(engine) as (session, statements):
            await MatchDetailsRepository(session).career_before(ids, now)
        assert len(statements) == 1, statements

    **Why a fresh session, not the ``db_session`` fixture.** The counter must see
    only the statements the code under test emits: a fresh
    ``async_sessionmaker`` session keeps the setup's already-committed INSERTs out
    of the count, and starts with an empty identity map so the shared session's
    cached rows / pending flushes can't mask a query the loader really would have
    issued against a cold session (which is what a real request gets).

    **Why the batching callers cite three ids.** A reintroduced per-user loop
    emits one statement per user, so three ids fail loudly against a pin of one —
    where a two-id list could still be read off as a coincidence.

    ``expire_on_commit=False``, as everywhere else in the suite (the ``db_session``
    fixture, the lock-race tests' sessionmakers): a caller counting the statements a
    *handler* emits — rather than a bare loader — would otherwise have every ORM
    instance expired by that handler's ``commit()``, and the next attribute read
    would try to refresh it from inside sync code (``MissingGreenlet``). It also
    keeps the count honest: an expiry-triggered reload is a statement the code under
    test never asked for.
    """
    statements: list[str] = []

    def before(conn: object, cursor: object, statement: str, *args: object) -> None:
        statements.append(statement)

    event.listen(engine.sync_engine, "before_cursor_execute", before)
    try:
        async with async_sessionmaker(engine, expire_on_commit=False)() as session:
            yield session, statements
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", before)


# ----- push notifications ---------------------------------------------------


@dataclass
class SentPush:
    """One recorded ``PushSender.send`` call."""

    token: str
    environment: str
    title: str
    body: str
    category: str | None
    data: Mapping[str, str] | None
    collapse_id: str | None = None


class FakeSender:
    """Records every send and returns a per-token outcome (default success).

    Drop-in for the ``PushSender`` protocol; install it with ``use_sender``."""

    def __init__(
        self,
        *,
        configured: bool = True,
        outcomes: dict[str, SendOutcome] | None = None,
    ) -> None:
        self.is_configured = configured
        self.sent: list[SentPush] = []
        self._outcomes = outcomes or {}

    async def send(
        self,
        token: str,
        *,
        environment: Environment,
        title: str,
        body: str,
        category: str | None = None,
        data: Mapping[str, str] | None = None,
        collapse_id: str | None = None,
    ) -> SendResult:
        self.sent.append(
            SentPush(token, environment, title, body, category, data, collapse_id)
        )
        return SendResult(self._outcomes.get(token, SendOutcome.SUCCESS))


def use_sender(sender: FakeSender) -> None:
    """Override the process-wide push sender for the duration of a test.
    ``api_client`` clears ``dependency_overrides`` afterwards."""
    fastapi_app.dependency_overrides[get_push_sender] = lambda: sender

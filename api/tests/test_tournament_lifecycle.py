"""Service-layer tests for the transport-neutral tournament-lifecycle verbs.

These drive ``app.tournament_lifecycle.create_tournament`` /
``delete_tournament`` directly with a raw ``db_session`` and no FastAPI — proving
each write path (the STRICT league resolution, the owner gate, the delete) runs,
persists, and signals every refusal with a **domain exception** from
``app.tournament_errors`` rather than an ``HTTPException``. The HTTP wire contract
those exceptions map back to is pinned by the unchanged endpoint tests in
``test_tournaments.py``; this file is the branch matrix behind them.
"""

import uuid
from decimal import Decimal

import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.geocoding import FakeGeocoder
from app.models import (
    DrawType,
    EventFormat,
    League,
    LeagueVisibility,
    RatingStrategy,
    ScheduleSolve,
    ScheduleSolveStatus,
    ScheduleSolveTrigger,
    Tournament,
    TournamentEntry,
    TournamentEntryStatus,
    TournamentEvent,
    TournamentEventDrawSettings,
    TournamentFixture,
    TournamentStatus,
    User,
)
from app.schemas.tournament import AddressInput, TournamentCreate, TournamentTable
from app.tournament_draws import cut_draw
from app.tournament_errors import (
    IllegalTournamentTransitionError,
    LeagueNotFoundError,
    NoDefaultLeagueError,
    NotTournamentOwnerError,
    TournamentAlreadyInStatusError,
    TournamentNotFoundError,
    TournamentNotReadyToGoLiveError,
)
from app.tournament_lifecycle import (
    create_tournament,
    delete_tournament,
    transition_tournament,
)
from tests._helpers import (
    CountingGeocoder,
    assert_tournament_address_is_sql_null,
    blank_addresses,
    make_user,
)

# The deterministic geocoder the create verb resolves the venue address with (the
# same one ``get_geocoder`` hands out under the suite's ``GEOCODER=fake``). A
# service-layer test builds it directly, exactly as it constructs the raw session.
_GEOCODER = FakeGeocoder()


@pytest_asyncio.fixture
async def other_league(
    db_session: AsyncSession, rating_strategies: dict[str, RatingStrategy]
) -> League:
    """A second, non-default league — so "runs on the league the caller named" is
    distinguishable from "carries the default, always" (the two ids differ).
    Mirrors the fixture of the same name in ``test_tournament_edit.py``."""
    league = League(
        name="Bay Area Ladder",
        description="A second ladder. Not the default.",
        visibility=LeagueVisibility.public,
        is_default=False,
        rating_strategy_id=rating_strategies["glicko2"].id,
    )
    db_session.add(league)
    await db_session.commit()
    return league


def _address() -> AddressInput:
    """The write-shape address a client sends on create — no coordinates (1c's
    verb geocodes it). Stored seeds add coordinates via ``_stored_address``."""
    return AddressInput(
        venue="Berkeley TT Club",
        street="2727 Milvia St",
        city="Berkeley",
        region="CA",
        postal="94703",
        country="USA",
    )


def _stored_address() -> dict[str, object]:
    """The stored/read-shape address dict a ``Tournament`` row holds: the write
    fields plus the NOT NULL geocoded coordinates."""
    return {**_address().model_dump(), "latitude": 37.8703, "longitude": -122.2731}


def _payload(*, league_id: uuid.UUID | None = None) -> TournamentCreate:
    return TournamentCreate(
        name="Bay Area Open 2026",
        description="Two-day open.",
        address=_address(),
        table_catalogue=[TournamentTable(id="t1", label="Table 1", court="A")],
        league_id=league_id,
    )


# ----- create --------------------------------------------------------------


async def test_create_persists_a_draft_owned_by_the_actor(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    actor = await make_user(db_session, "lifecycle-create-owner")
    actor_id = actor.id

    tournament = await create_tournament(
        db_session, actor=actor, payload=_payload(), geocoder=_GEOCODER
    )

    assert tournament.created_by_user_id == actor.id
    # Born ``draft`` from the column default — never set on the create path.
    assert tournament.status is TournamentStatus.draft
    # An omitted league binds the default ladder.
    assert tournament.league_id == default_league.id
    assert tournament.name == "Bay Area Open 2026"
    # Capture the PK before ``expire_all`` — reading it afterwards would trigger a
    # sync lazy-load on the expired instance.
    tournament_id = tournament.id

    # Persisted, not merely returned.
    db_session.expire_all()
    row = (
        await db_session.execute(
            select(Tournament).where(Tournament.id == tournament_id)
        )
    ).scalar_one()
    assert row.created_by_user_id == actor_id
    assert row.table_catalogue == [{"id": "t1", "label": "Table 1", "court": "A"}]


async def test_create_naming_a_league_runs_on_that_league(
    db_session: AsyncSession,
    default_league: League,
    other_league: League,
) -> None:
    actor = await make_user(db_session, "lifecycle-create-league")

    tournament = await create_tournament(
        db_session,
        actor=actor,
        payload=_payload(league_id=other_league.id),
        geocoder=_GEOCODER,
    )

    assert tournament.league_id == other_league.id


async def test_create_naming_a_missing_league_raises_not_found(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    actor = await make_user(db_session, "lifecycle-create-bad-league")
    actor_id = actor.id

    with pytest.raises(LeagueNotFoundError):
        await create_tournament(
            db_session,
            actor=actor,
            payload=_payload(league_id=uuid.uuid4()),
            geocoder=_GEOCODER,
        )

    # The STRICT resolution created nothing.
    db_session.expire_all()
    assert (
        await db_session.execute(
            select(Tournament).where(Tournament.created_by_user_id == actor_id)
        )
    ).scalar_one_or_none() is None


async def test_create_without_a_league_and_no_default_raises(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """With no ``league_id`` and no default league configured, the create verb has
    nothing to bind the NOT NULL column to — the transport-neutral twin of the
    ``resolve_league`` 500."""
    actor = await make_user(db_session, "lifecycle-create-no-default")
    # Remove the default league seeded by the fixture.
    await db_session.delete(default_league)
    await db_session.commit()

    with pytest.raises(NoDefaultLeagueError):
        await create_tournament(
            db_session, actor=actor, payload=_payload(), geocoder=_GEOCODER
        )


# ----- create with NO venue -------------------------------------------------
#
# The ``CountingGeocoder`` below is here for the *negative* claim: a create with no
# venue must not call the geocoder **at all**. Asserting only "the create returned a
# tournament" would not distinguish that from a geocode that happened to resolve — and
# the whole reason no-venue was unreachable is that a blank address composed to ``""``
# and was refused by the geocoder, so "was the geocoder asked" is the question with the
# history behind it.


async def test_create_with_an_omitted_address_stores_no_venue_and_never_geocodes(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """A tournament announced before its venue is booked is created with the ``address``
    key simply absent — and that must reach the column as SQL ``NULL`` without the
    geocoder being consulted at all (#1206).

    The geocode-call count is the load-bearing assertion, not the 201-equivalent. The
    state was unreachable precisely *because* the write path always geocoded: an absent
    or blank address composes to ``""``, which resolves to zero candidates and is
    refused as a coded 409. A test that only asserted "the create returned a tournament"
    would stay green against a verb that geocoded ``""`` and got lucky.
    """
    actor = await make_user(db_session, "lifecycle-create-no-venue")
    counting = CountingGeocoder()

    tournament = await create_tournament(
        db_session,
        actor=actor,
        payload=TournamentCreate(name="Announced, Venue TBC"),
        geocoder=counting,
    )
    tournament_id = tournament.id

    assert counting.calls == 0
    assert tournament.address is None

    # Persisted as SQL NULL, not merely returned as ``None`` — and specifically not as
    # the JSONB ``null`` literal, which reads back as ``None`` just the same. The
    # docstring's claim is about the *encoding*, so the assertion has to be too;
    # ``row.address is None`` alone cannot see the difference (see the helper).
    db_session.expire_all()
    row = (
        await db_session.execute(
            select(Tournament).where(Tournament.id == tournament_id)
        )
    ).scalar_one()
    assert row.address is None
    await assert_tournament_address_is_sql_null(db_session, tournament_id)


async def test_a_tournament_with_no_venue_is_found_by_a_sql_is_null_predicate(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """The venue-less tournament the create verb just wrote is matched by
    ``Tournament.address.is_(None)`` — the predicate any "has no venue" read path will
    reach for first.

    This guards a footgun rather than a feature. Before ``none_as_null=True`` this query
    returned **zero rows** against a table where every tournament had no venue, and did
    so silently: the column stored the JSONB ``null`` literal, which ``IS NULL`` does
    not match, while every Python-side ``t.address is None`` said otherwise. A read
    built on that would ship an empty list with nothing to debug from. Written from the
    consumer's side deliberately — the encoding is only interesting because of the
    predicate it does or doesn't satisfy — and paired here with a venue-bearing row so a
    predicate that matched *everything* would red too.
    """
    actor = await make_user(db_session, "lifecycle-is-null-predicate")

    venueless = await create_tournament(
        db_session,
        actor=actor,
        payload=TournamentCreate(name="Venue TBC"),
        geocoder=_GEOCODER,
    )
    with_venue = await create_tournament(
        db_session,
        actor=actor,
        payload=TournamentCreate(name="Bay Area Open", address=_address()),
        geocoder=_GEOCODER,
    )
    # Read the ids off before expiring, so the queries below are the only IO.
    actor_id, venueless_id, with_venue_id = actor.id, venueless.id, with_venue.id

    db_session.expire_all()
    matched = (
        (
            await db_session.execute(
                select(Tournament.id)
                .where(Tournament.created_by_user_id == actor_id)
                .where(Tournament.address.is_(None))
            )
        )
        .scalars()
        .all()
    )

    assert list(matched) == [venueless_id]

    # ...and its complement, so "has a venue" is reachable by the mirror predicate too.
    matched_not_null = (
        (
            await db_session.execute(
                select(Tournament.id)
                .where(Tournament.created_by_user_id == actor_id)
                .where(Tournament.address.is_not(None))
            )
        )
        .scalars()
        .all()
    )

    assert list(matched_not_null) == [with_venue_id]


@blank_addresses
async def test_create_with_an_all_blank_address_stores_no_venue_and_never_geocodes(
    db_session: AsyncSession,
    default_league: League,
    blank: dict[str, str],
) -> None:
    """The same claim through the gesture a **browser** organizer can actually make.

    The web form submits six controlled text inputs; it has no way to omit the
    ``address`` key. So the all-blank submission is the one that matters for the bug
    #1206 is about, and it must behave identically to an omission — normalized to "no
    venue" at the boundary, before the geocoder is asked. Whitespace counts as blank: a
    stray space in one of six boxes is not a venue.

    "Identically to an omission" is asserted down to the *encoding*: the same true SQL
    NULL, not the JSONB ``null`` literal, so both gestures land on the one stored
    representation of "no venue" rather than on two that merely read back alike.
    """
    actor = await make_user(db_session, "lifecycle-create-blank-venue")
    counting = CountingGeocoder()

    tournament = await create_tournament(
        db_session,
        actor=actor,
        payload=TournamentCreate(name="Private Tournament", address=blank),
        geocoder=counting,
    )
    tournament_id = tournament.id

    assert counting.calls == 0
    assert tournament.address is None

    db_session.expire_all()
    row = (
        await db_session.execute(
            select(Tournament).where(Tournament.id == tournament_id)
        )
    ).scalar_one()
    assert row.address is None
    await assert_tournament_address_is_sql_null(db_session, tournament_id)


# ----- delete --------------------------------------------------------------


async def _make_tournament(
    db: AsyncSession, *, owner: User, league: League
) -> Tournament:
    tournament = Tournament(
        name="Deletable Cup",
        address=_stored_address(),
        table_catalogue=[],
        league_id=league.id,
        created_by_user_id=owner.id,
        status=TournamentStatus.draft,
    )
    db.add(tournament)
    await db.commit()
    await db.refresh(tournament)
    return tournament


async def test_delete_removes_an_owned_tournament(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    owner = await make_user(db_session, "lifecycle-delete-owner")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    tournament_id = tournament.id

    await delete_tournament(db_session, tournament_id=tournament_id, actor=owner)

    db_session.expire_all()
    assert (
        await db_session.execute(
            select(Tournament).where(Tournament.id == tournament_id)
        )
    ).scalar_one_or_none() is None


async def test_delete_of_a_non_owned_tournament_raises_not_owner(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    owner = await make_user(db_session, "lifecycle-delete-guard-owner")
    stranger = await make_user(db_session, "lifecycle-delete-stranger")
    tournament = await _make_tournament(db_session, owner=owner, league=default_league)
    tournament_id = tournament.id

    with pytest.raises(NotTournamentOwnerError):
        await delete_tournament(db_session, tournament_id=tournament_id, actor=stranger)

    # Nothing was deleted.
    db_session.expire_all()
    assert (
        await db_session.execute(
            select(Tournament).where(Tournament.id == tournament_id)
        )
    ).scalar_one_or_none() is not None


async def test_delete_of_a_missing_id_raises_not_found(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """404 is judged before 403: a missing id raises not-found, so a non-owner
    never learns whether an absent id existed."""
    actor = await make_user(db_session, "lifecycle-delete-missing")

    with pytest.raises(TournamentNotFoundError):
        await delete_tournament(db_session, tournament_id=uuid.uuid4(), actor=actor)


# ----- transition ----------------------------------------------------------
#
# The lifecycle branch matrix behind ``POST /v1/tournaments/{id}/transitions``. The
# three legal edges are stated independently of ``LEGAL_TRANSITIONS`` (a test that
# read its expectations out of the table under test would agree with it however wrong
# it got); the illegal edges cover the three refusal shapes — a backward/skip edge, a
# re-asserted self-transition, and moving out of the terminal ``archived``.

_DATE = "2030-01-01"


async def _make_tournament_at(
    db: AsyncSession,
    *,
    owner: User,
    league: League,
    status: TournamentStatus,
    with_event: bool = False,
) -> Tournament:
    """A tournament owned by ``owner`` at ``status``, optionally with one pooled,
    unrated, round-robin singles event (no entrants, no draw yet — the caller cuts
    it)."""
    tournament = Tournament(
        name="Lifecycle Cup",
        address=_stored_address(),
        table_catalogue=[
            {"id": "t1", "label": "Table 1", "court": "A"},
            {"id": "t2", "label": "Table 2", "court": "A"},
        ],
        league_id=league.id,
        created_by_user_id=owner.id,
        status=status,
    )
    db.add(tournament)
    await db.flush()
    if with_event:
        event = TournamentEvent(
            tournament_id=tournament.id,
            name="Open Singles",
            format=EventFormat.singles,
            draw_settings=TournamentEventDrawSettings.for_draw_type(
                DrawType.round_robin
            ),
            max_players=None,
            entry_fee=Decimal("0.00"),
            timezone="America/Chicago",
            slot={"date": _DATE, "start": "09:00", "end": "17:00"},
            match_settings={"rated": False, "length_games": 3},
            pools=[
                {
                    "id": "pool-a",
                    "name": "Pool A",
                    "slot": {"date": _DATE, "start": "09:00", "end": "17:00"},
                    "table_ids": ["t1", "t2"],
                }
            ],
        )
        db.add(event)
        await db.flush()
    await db.commit()
    await db.refresh(tournament)
    return tournament


async def _one_event(db: AsyncSession, tournament_id: uuid.UUID) -> TournamentEvent:
    return (
        await db.execute(
            select(TournamentEvent).where(
                TournamentEvent.tournament_id == tournament_id
            )
        )
    ).scalar_one()


async def _enter(db: AsyncSession, event: TournamentEvent, count: int) -> None:
    for _ in range(count):
        db.add(
            TournamentEntry(
                event_id=event.id,
                user_id=(await make_user(db, f"tx-entrant-{uuid.uuid4().hex}")).id,
                status=TournamentEntryStatus.entered,
            )
        )
    await db.commit()


async def test_transition_draft_to_published_moves_and_persists(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    owner = await make_user(db_session, "tx-publish-owner")
    tournament = await _make_tournament_at(
        db_session, owner=owner, league=default_league, status=TournamentStatus.draft
    )
    tournament_id = tournament.id

    moved = await transition_tournament(
        db_session,
        tournament_id=tournament_id,
        actor=owner,
        to=TournamentStatus.published,
    )

    assert moved.status is TournamentStatus.published
    db_session.expire_all()
    row = (
        await db_session.execute(
            select(Tournament).where(Tournament.id == tournament_id)
        )
    ).scalar_one()
    assert row.status is TournamentStatus.published


async def test_transition_live_to_archived_moves_and_persists(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    owner = await make_user(db_session, "tx-archive-owner")
    tournament = await _make_tournament_at(
        db_session, owner=owner, league=default_league, status=TournamentStatus.live
    )
    tournament_id = tournament.id

    moved = await transition_tournament(
        db_session,
        tournament_id=tournament_id,
        actor=owner,
        to=TournamentStatus.archived,
    )

    assert moved.status is TournamentStatus.archived
    db_session.expire_all()
    row = (
        await db_session.execute(
            select(Tournament).where(Tournament.id == tournament_id)
        )
    ).scalar_one()
    assert row.status is TournamentStatus.archived


async def test_transition_published_to_live_materializes_matches_and_queues_a_solve(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """The highest-risk edge: going live seats a cut draw's fixtures into real matches
    (materialization) AND queues the day's first schedule solve with the ``go_live``
    trigger — both in the same transaction as the status write."""
    owner = await make_user(db_session, "tx-golive-owner")
    tournament = await _make_tournament_at(
        db_session,
        owner=owner,
        league=default_league,
        status=TournamentStatus.published,
        with_event=True,
    )
    tournament_id = tournament.id
    event = await _one_event(db_session, tournament_id)
    event_id = event.id
    await _enter(db_session, event, 4)
    await cut_draw(db_session, event)
    await db_session.commit()

    moved = await transition_tournament(
        db_session,
        tournament_id=tournament_id,
        actor=owner,
        to=TournamentStatus.live,
    )

    assert moved.status is TournamentStatus.live

    # Every fixture materialized into a real match (idempotent on ``match_id``).
    db_session.expire_all()
    fixtures = list(
        (
            await db_session.execute(
                select(TournamentFixture).where(TournamentFixture.event_id == event_id)
            )
        )
        .scalars()
        .all()
    )
    assert fixtures, "the cut draw produced fixtures"
    assert all(f.match_id is not None for f in fixtures), (
        "go-live materialized every ready fixture into a match"
    )

    # And a solve was queued for the go-live, with the ``go_live`` trigger.
    solves = list(
        (
            await db_session.execute(
                select(ScheduleSolve).where(
                    ScheduleSolve.tournament_id == tournament_id
                )
            )
        )
        .scalars()
        .all()
    )
    assert len(solves) == 1
    assert solves[0].trigger is ScheduleSolveTrigger.go_live
    assert solves[0].status is ScheduleSolveStatus.queued


async def test_transition_backward_edge_raises_illegal_with_both_ends(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    owner = await make_user(db_session, "tx-backward-owner")
    tournament = await _make_tournament_at(
        db_session,
        owner=owner,
        league=default_league,
        status=TournamentStatus.published,
    )

    with pytest.raises(IllegalTournamentTransitionError) as exc_info:
        await transition_tournament(
            db_session,
            tournament_id=tournament.id,
            actor=owner,
            to=TournamentStatus.draft,
        )
    exc = exc_info.value
    assert exc.status == "published"
    assert exc.to == "draft"
    assert str(exc) == "This tournament is published; it cannot be moved to draft."


async def test_transition_skip_edge_raises_illegal_with_both_ends(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """draft → live skips the ``published`` stage: a genuinely illegal jump, named at
    both ends (and it never touches the go-live precondition, judged after the edge)."""
    owner = await make_user(db_session, "tx-skip-owner")
    tournament = await _make_tournament_at(
        db_session, owner=owner, league=default_league, status=TournamentStatus.draft
    )

    with pytest.raises(IllegalTournamentTransitionError) as exc_info:
        await transition_tournament(
            db_session,
            tournament_id=tournament.id,
            actor=owner,
            to=TournamentStatus.live,
        )
    assert str(exc_info.value) == (
        "This tournament is draft; it cannot be moved to live."
    )


async def test_transition_out_of_archived_raises_illegal(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """``archived`` is terminal: no edge leaves it, so even a plausible-looking move
    is refused as illegal (both ends named)."""
    owner = await make_user(db_session, "tx-outofarchived-owner")
    tournament = await _make_tournament_at(
        db_session,
        owner=owner,
        league=default_league,
        status=TournamentStatus.archived,
    )

    with pytest.raises(IllegalTournamentTransitionError) as exc_info:
        await transition_tournament(
            db_session,
            tournament_id=tournament.id,
            actor=owner,
            to=TournamentStatus.live,
        )
    assert exc_info.value.status == "archived"
    assert exc_info.value.to == "live"


async def test_transition_self_edge_raises_already_in_status(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """Re-asserting the status a tournament already holds is its OWN refusal — a
    single-ended sentence naming the fact somebody already did it, not the two-ended
    tautology an illegal edge gets."""
    owner = await make_user(db_session, "tx-self-owner")
    tournament = await _make_tournament_at(
        db_session, owner=owner, league=default_league, status=TournamentStatus.live
    )

    with pytest.raises(TournamentAlreadyInStatusError) as exc_info:
        await transition_tournament(
            db_session,
            tournament_id=tournament.id,
            actor=owner,
            to=TournamentStatus.live,
        )
    exc = exc_info.value
    assert exc.status == "live"
    assert str(exc) == "This tournament is already live."
    assert "cannot be moved" not in str(exc)


async def test_go_live_with_no_events_raises_precondition(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """A published tournament with no events cannot start (the vacuously-true case,
    ADR-0786): the precondition refuses it, flagged ``no_events``."""
    owner = await make_user(db_session, "tx-noevents-owner")
    tournament = await _make_tournament_at(
        db_session,
        owner=owner,
        league=default_league,
        status=TournamentStatus.published,
    )
    # Capture the PK before ``expire_all`` — reading it afterwards would trigger a
    # sync lazy-load on the expired instance.
    tournament_id = tournament.id

    with pytest.raises(TournamentNotReadyToGoLiveError) as exc_info:
        await transition_tournament(
            db_session,
            tournament_id=tournament_id,
            actor=owner,
            to=TournamentStatus.live,
        )
    exc = exc_info.value
    assert exc.no_events is True
    assert exc.uncut == []
    assert exc.stale == []
    assert "no events" in str(exc)

    # Nothing was moved — it is still published.
    db_session.expire_all()
    row = (
        await db_session.execute(
            select(Tournament).where(Tournament.id == tournament_id)
        )
    ).scalar_one()
    assert row.status is TournamentStatus.published


async def test_go_live_with_an_uncut_event_names_it(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """An event whose draw was never cut refuses go-live, naming the event (by name,
    never by id) in the ``uncut`` list."""
    owner = await make_user(db_session, "tx-uncut-owner")
    tournament = await _make_tournament_at(
        db_session,
        owner=owner,
        league=default_league,
        status=TournamentStatus.published,
        with_event=True,
    )
    event = await _one_event(db_session, tournament.id)
    await _enter(db_session, event, 4)  # entered, but never cut

    with pytest.raises(TournamentNotReadyToGoLiveError) as exc_info:
        await transition_tournament(
            db_session,
            tournament_id=tournament.id,
            actor=owner,
            to=TournamentStatus.live,
        )
    exc = exc_info.value
    assert exc.no_events is False
    assert exc.uncut == ["Open Singles"]
    assert exc.stale == []
    assert "“Open Singles” has no draw yet" in str(exc)
    assert str(event.id) not in str(exc)


async def test_go_live_with_a_stale_draw_names_it(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """A draw cut before a further entrant arrived is stale — its fixtures no longer
    seat the active field — so go-live is refused, naming the event in the ``stale``
    list."""
    owner = await make_user(db_session, "tx-stale-owner")
    tournament = await _make_tournament_at(
        db_session,
        owner=owner,
        league=default_league,
        status=TournamentStatus.published,
        with_event=True,
    )
    event = await _one_event(db_session, tournament.id)
    await _enter(db_session, event, 4)
    await cut_draw(db_session, event)
    await db_session.commit()
    # Somebody enters AFTER the cut — the draw now seats a field that has changed.
    await _enter(db_session, event, 1)

    with pytest.raises(TournamentNotReadyToGoLiveError) as exc_info:
        await transition_tournament(
            db_session,
            tournament_id=tournament.id,
            actor=owner,
            to=TournamentStatus.live,
        )
    exc = exc_info.value
    assert exc.uncut == []
    assert exc.stale == ["Open Singles"]
    assert "no longer matches its entrants" in str(exc)


async def test_transition_by_non_owner_raises_not_owner(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """403 is judged after the 404 (the locked owner-loader), so a stranger who is not
    the owner is refused — before the edge is even judged, so the response never leaks
    what status a tournament they cannot touch is in."""
    owner = await make_user(db_session, "tx-guard-owner")
    stranger = await make_user(db_session, "tx-guard-stranger")
    tournament = await _make_tournament_at(
        db_session, owner=owner, league=default_league, status=TournamentStatus.draft
    )

    with pytest.raises(NotTournamentOwnerError):
        await transition_tournament(
            db_session,
            tournament_id=tournament.id,
            actor=stranger,
            to=TournamentStatus.published,
        )


async def test_transition_of_a_missing_id_raises_not_found(
    db_session: AsyncSession,
    default_league: League,
) -> None:
    """404 is judged before 403: a missing id raises not-found, so a non-owner never
    learns whether an absent id existed."""
    actor = await make_user(db_session, "tx-missing-actor")

    with pytest.raises(TournamentNotFoundError):
        await transition_tournament(
            db_session,
            tournament_id=uuid.uuid4(),
            actor=actor,
            to=TournamentStatus.published,
        )

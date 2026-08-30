"""Read-side tournament/fixture context on ``MatchDetails`` (#1288).

Covers two additions:

- ``MatchDetails.not_scorable_reason`` — populated by the same
  ``_scorability_reason`` helper ``ensure_scorable`` (``app/match_scoring.py``)
  picks its 409/422 branch from, so a client can explain (or refuse to render a
  score form for) a non-scorable match before the write path ever rejects it.
- ``MatchDetails.tournament`` — the fixture's tournament/event/table context,
  ``None`` for a casual match or when the viewer must not see this tournament
  yet (an unannounced tournament is owner-only, mirroring
  ``app.tournament_queries.visible_to``).

Seeded straight through the ORM (mirroring ``tests/test_match_calls.py``'s
``_make_tournament`` and ``tests/test_tournament_fixtures.py``'s
``_make_event``) rather than through the real cut-draw/go-live/call pipeline:
nothing here is about how a fixture gets called or placed, only about what the
match-details BFF reports once it already is (or isn't)."""

import uuid
from decimal import Decimal

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.leagues import get_default_league
from app.match_creation import create_match
from app.models import (
    DrawType,
    EventFormat,
    Match,
    MatchSettings,
    MatchSide,
    MatchSidePlayer,
    MatchStatus,
    Tournament,
    TournamentEvent,
    TournamentEventDrawSettings,
    TournamentFixture,
    TournamentStatus,
    User,
)
from app.tournament_event_stages import mint_stages
from tests._helpers import (
    event_groups,
    make_client,
    make_user,
    start_session,
    venue_tables,
)


async def _make_tournament(
    db_session: AsyncSession,
    *,
    owner: User,
    status: TournamentStatus,
    table_labels: tuple[str, ...] = (),
) -> tuple[Tournament, TournamentEvent]:
    """A single-elim event under a tournament in ``status``, with an optional
    table catalogue — seeded directly, no draw is ever cut."""
    league = await get_default_league(db_session)
    assert league is not None, "the autouse default_league fixture seeds this"

    catalogue = venue_tables(*((label, "Main") for label in table_labels))
    tournament = Tournament(
        name="Fixture Context Open",
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
        tables=catalogue,
        league_id=league.id,
        created_by_user_id=owner.id,
    )
    db_session.add(tournament)
    await db_session.flush()

    stages = mint_stages(DrawType.single_elim)
    event = TournamentEvent(
        tournament_id=tournament.id,
        name="Open Singles",
        format=EventFormat.singles,
        draw_settings=TournamentEventDrawSettings.for_draw_type(DrawType.single_elim),
        max_players=8,
        entry_fee=Decimal("0.00"),
        timezone="America/Chicago",
        slot={"date": "2026-08-01", "start": "09:00", "end": "17:00"},
        match_settings={"rated": False, "length_games": 3},
        stages=stages,
    )
    # Every stage holds exactly one group now (#1484), even ungrouped-by-nature
    # single-elim — a fixture always names one.
    stages[0].groups = event_groups([], event=event, group_count=1)
    db_session.add(event)
    await db_session.commit()
    await db_session.refresh(event, attribute_names=["groups", "stages"])
    return tournament, event


def _add_side(match: Match, *, side_number: int, user: User) -> None:
    side = MatchSide(match=match, side_number=side_number)
    side.players.append(MatchSidePlayer(match=match, user_id=user.id))


async def _make_fixture_match(
    db_session: AsyncSession,
    tournament: Tournament,
    event: TournamentEvent,
    *,
    side_1: User,
    side_2: User,
    match_status: MatchStatus,
    table_id: str | None = None,
) -> Match:
    """A tournament match wired to a fresh fixture in ``event`` — the fixture
    reverse lookup ``tournament_context`` runs (``TournamentFixture.match_id ==
    match.id``) and, when ``table_id`` is given, a placement on that table."""
    match = Match(
        match_settings=MatchSettings(team_size=1, best_of=3, affects_rating=False),
        league_id=tournament.league_id,
        created_by_user_id=tournament.created_by_user_id,
        status=match_status,
    )
    _add_side(match, side_number=1, user=side_1)
    _add_side(match, side_number=2, user=side_2)
    db_session.add(match)
    await db_session.flush()

    fixture = TournamentFixture(
        stage_id=event.stages[0].id,
        group_id=event.groups[0].id,
        round=1,
        position=1,
        entry_a_id=None,
        entry_b_id=None,
        match_id=match.id,
        table_id=table_id,
    )
    db_session.add(fixture)
    await db_session.commit()
    return match


async def _get_match(client: AsyncClient, match_id: uuid.UUID) -> dict:
    response = await client.get(f"/v1/matches/{match_id}")
    assert response.status_code == 200
    return response.json()


async def test_casual_match_has_no_tournament_context_and_is_scorable(
    api_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A casual (non-tournament) match reports ``tournament: None`` — there's
    no fixture pointing at it — and, being freshly created (two real sides,
    in_progress, no result), ``not_scorable_reason: None``."""
    creator = await start_session(api_client, db_session)
    opponent = await make_user(db_session, "casual-opponent")
    created = await create_match(
        db_session,
        creator=creator,
        opponent_user_id=opponent.id,
        league_id=None,
        best_of=3,
        rated=True,
    )

    body = await _get_match(api_client, created.id)
    assert body["tournament"] is None
    assert body["not_scorable_reason"] is None


async def test_uncalled_fixture_on_live_tournament_reports_not_called(
    api_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A tournament match born ``pending`` (not yet called to a table) reports
    ``not_scorable_reason: not_called``, and — since the tournament is
    ``live`` (announced) — the tournament context, with ``table_label: None``
    since the fixture was never placed."""
    owner = await make_user(db_session, "live-director")
    tournament, event = await _make_tournament(
        db_session, owner=owner, status=TournamentStatus.live
    )
    p1 = await make_user(db_session, "live-p1")
    p2 = await make_user(db_session, "live-p2")
    match = await _make_fixture_match(
        db_session,
        tournament,
        event,
        side_1=p1,
        side_2=p2,
        match_status=MatchStatus.pending,
    )

    async with make_client() as anon_client:
        body = await _get_match(anon_client, match.id)

    assert body["not_scorable_reason"] == "not_called"
    assert body["tournament"] is not None
    assert body["tournament"]["tournament_id"] == str(tournament.id)
    assert body["tournament"]["tournament_status"] == "live"
    assert body["tournament"]["event_id"] == str(event.id)
    assert body["tournament"]["table_label"] is None
    assert body["tournament"]["can_edit"] is False


async def test_placed_fixture_before_go_live_shows_table_and_non_live_status(
    api_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A fixture already placed on a table, but whose tournament hasn't gone
    live yet, reports the table label alongside the tournament's real
    (non-live) status — so the FE can tell "placed, not live" apart from
    "called" without a raw ``pinned_at`` timestamp."""
    owner = await make_user(db_session, "published-director")
    tournament, event = await _make_tournament(
        db_session,
        owner=owner,
        status=TournamentStatus.published,
        table_labels=("Table 1",),
    )
    table_id = str(tournament.tables[0].id)
    p1 = await make_user(db_session, "published-p1")
    p2 = await make_user(db_session, "published-p2")
    match = await _make_fixture_match(
        db_session,
        tournament,
        event,
        side_1=p1,
        side_2=p2,
        match_status=MatchStatus.pending,
        table_id=table_id,
    )

    async with make_client() as anon_client:
        body = await _get_match(anon_client, match.id)

    assert body["tournament"]["tournament_status"] == "published"
    assert body["tournament"]["table_label"] == "Table 1"
    assert body["not_scorable_reason"] == "not_called"


async def test_draft_tournament_hides_context_from_non_owner_and_anonymous(
    api_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A draft tournament is unannounced — owner-only, mirroring
    ``app.tournament_queries.visible_to``. Neither an anonymous caller nor a
    signed-in non-owner sees the tournament context."""
    owner = await make_user(db_session, "draft-director")
    tournament, event = await _make_tournament(
        db_session, owner=owner, status=TournamentStatus.draft
    )
    p1 = await make_user(db_session, "draft-p1")
    p2 = await make_user(db_session, "draft-p2")
    match = await _make_fixture_match(
        db_session,
        tournament,
        event,
        side_1=p1,
        side_2=p2,
        match_status=MatchStatus.pending,
    )

    async with make_client() as anon_client:
        anon_body = await _get_match(anon_client, match.id)
    assert anon_body["tournament"] is None

    non_owner = await start_session(api_client, db_session)
    del non_owner
    other_body = await _get_match(api_client, match.id)
    assert other_body["tournament"] is None


async def test_draft_tournament_shows_context_to_its_owner(
    db_session: AsyncSession,
) -> None:
    """The tournament's own creator can always see its context, draft or not
    — ``can_edit`` reflects the ownership that unlocked the view."""
    async with make_client() as owner_client:
        owner = await start_session(owner_client, db_session)
        tournament, event = await _make_tournament(
            db_session, owner=owner, status=TournamentStatus.draft
        )
        p1 = await make_user(db_session, "draft-owner-p1")
        p2 = await make_user(db_session, "draft-owner-p2")
        match = await _make_fixture_match(
            db_session,
            tournament,
            event,
            side_1=p1,
            side_2=p2,
            match_status=MatchStatus.pending,
        )

        body = await _get_match(owner_client, match.id)

    assert body["tournament"] is not None
    assert body["tournament"]["can_edit"] is True
    assert body["tournament"]["tournament_status"] == "draft"

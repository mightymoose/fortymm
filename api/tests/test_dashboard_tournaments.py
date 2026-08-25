"""``DashboardResponse.tournaments`` — the panel that tops the dashboard while the
caller is playing in a live tournament.

Read through the real ``GET /v1/dashboard`` rather than the builder, because the shape
on the wire is the contract the panel renders. The tournaments themselves are built
through the real tournament routes (create → enter → cut → go live → call → play), so
what the panel projects is what the product actually writes.
"""

import logging
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any
from unittest.mock import patch

import pytest
from httpx import AsyncClient
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.dashboard_tournaments import (
    _format_date_range,
    _subtitle,
    build_tournament_panels,
)
from app.draws import seats_both_sides_at_cut
from app.match_voiding import void_match
from app.models import (
    Match,
    MatchStatus,
    Tournament,
    TournamentEntryStatus,
    TournamentFixture,
    TournamentStatus,
    User,
)
from tests._helpers import counted_statements, make_user, opponent_session
from tests.test_tournaments import (
    RESERVATION_A,
    RESERVATION_B,
    _call_fixtures,
    _cut_the_draw,
    _enter,
    _event_payload,
    _fixture_rows,
    _go_live,
    _live_two_player_group,
    _rr_payload,
    _set_status,
    _tournament_with_events,
    _win_fixture_match,
)
from tests.test_tournaments import (
    _withdraw as _withdraw_entry,
)

# The tournament suite's own fixture — the primary client with a real session holding
# the tournament permissions the create/read routes gate on. Imported (rather than
# re-declared) so a change to what a director may do reaches this file too.
from tests.test_tournaments import authed_client as authed_client  # noqa: F401


async def _panels(client: AsyncClient) -> list[dict[str, Any]]:
    response = await client.get("/v1/dashboard")
    assert response.status_code == 200, response.text
    panels: list[dict[str, Any]] = response.json()["tournaments"]
    return panels


async def test_a_player_in_no_tournament_gets_no_panel(
    authed_client: tuple[AsyncClient, User],
) -> None:
    """The overwhelmingly common case: nobody is mid-tournament most days, so the
    field is an empty list and the dashboard renders no panel at all — not an empty
    one with a heading and nothing under it."""
    client, _ = authed_client

    assert await _panels(client) == []


async def test_a_live_tournament_the_caller_is_entered_in_becomes_a_panel(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """The whole projection, end to end: a live round-robin the caller is playing in
    comes back as one panel, with a tab for the event, the live match in the card, the
    caller's own record and group position, and their schedule."""
    client, owner = authed_client
    async with opponent_session(db_session, "panel-opp") as (_opp_client, opp):
        await _live_two_player_group(client, owner, opp, db_session, rated=True)

        (panel,) = await _panels(client)

    assert panel["live_count"] == 1, "the caller's called match is being played now"
    (event,) = panel["events"]
    assert event["is_live"] is True
    assert event["draw_type"] == "round-robin"
    assert event["stage_label"] == "Group play"
    assert event["group_label"] == "Group A", (
        "the group the caller was drawn into, by its derived position label — never "
        "the reservation's own stored name"
    )

    card = event["match"]
    assert card["state"] == "live"
    assert card["opponent_username"] == "panel-opp"
    assert card["your_games"] == 0 and card["opponent_games"] == 0
    assert card["best_of"] == 3
    assert card["round_label"] == "Group match 1"
    assert card["next_game_number"] == 1, (
        "the card deep-links straight to the game that is about to be played"
    )
    assert card["you_won"] is None, "a match still being played has no outcome"

    (row,) = event["fixtures"]
    assert row["label"] == "M1"
    assert row["state"] == "live"
    assert row["detail"] == "In progress"
    assert row["opponent_username"] == "panel-opp"


async def test_the_panel_states_the_score_from_the_callers_own_side(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """The side flip, which is the whole reason this projection exists.

    A fixture seats ``entry_a`` on side 1 and ``entry_b`` on side 2 (#788), so a raw
    side-shaped score reads *backwards* for whichever player is entry B. Here the
    caller is entry B and the board is 5–11 in side terms — a game they **won** — and
    every number the panel gives them says so: ``your_games`` is 1, and the game chip
    reads 11–5 their way round.

    Proven by handing the same match to both players and asserting the two panels are
    mirror images. Asserting only the caller's side would pass just as well if the
    server never flipped anything and the caller happened to be entry A.
    """
    client, owner = authed_client
    async with opponent_session(db_session, "flip-opp") as (opp_client, opp):
        # Owner is seed 1 → entry A → side 1. The *opponent* is entry B, so the
        # opponent's panel is the one that must be flipped.
        _tid, _event, _e_owner, _e_opp, fixture = await _live_two_player_group(
            client, owner, opp, db_session, rated=True
        )
        write = await client.post(
            f"/v1/matches/{fixture.match_id}/games/1/scores/new",
            json={"side_1_points": 5, "side_2_points": 11},
        )
        assert write.status_code == 201, write.text

        (owner_panel,) = await _panels(client)
        (opp_panel,) = await _panels(opp_client)

    owner_card = owner_panel["events"][0]["match"]
    opp_card = opp_panel["events"][0]["match"]

    assert (owner_card["your_games"], owner_card["opponent_games"]) == (0, 1)
    assert (opp_card["your_games"], opp_card["opponent_games"]) == (1, 0), (
        "entry B won that game, and their own panel must say so"
    )
    assert owner_card["games"] == [
        {"number": 1, "your_points": 5, "opponent_points": 11}
    ]
    assert opp_card["games"] == [{"number": 1, "your_points": 11, "opponent_points": 5}]
    assert owner_card["opponent_username"] == "flip-opp"
    assert opp_card["opponent_username"] == owner.username


async def test_a_completed_match_carries_its_outcome_and_the_record_follows(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """Once the caller's only match is decided, the card flips to ``completed`` with
    the outcome stated from their side, the path row states the result, and the stats
    strip reads the standings the tournament page reads (ADR-0788) rather than a second
    count of the same match."""
    client, owner = authed_client
    async with opponent_session(db_session, "done-opp") as (opp_client, opp):
        _tid, _event, e_owner, e_opp, fixture = await _live_two_player_group(
            client, owner, opp, db_session, rated=True
        )
        await _win_fixture_match(
            fixture,
            clients_by_entry={e_owner.id: client, e_opp.id: opp_client},
            winner_entry_id=e_owner.id,
            rated=True,
        )

        (panel,) = await _panels(client)
        (loser_panel,) = await _panels(opp_client)

    assert panel["live_count"] == 0, "nothing of the caller's is being played now"
    event = panel["events"][0]
    assert event["is_live"] is False
    assert (event["wins"], event["losses"]) == (1, 0)
    assert event["position"] == 1 and event["field_size"] == 2
    assert event["stage_label"] == "Group complete", (
        "the group's only fixture is decided, so group play is over"
    )

    card = event["match"]
    assert card["state"] == "completed"
    assert card["you_won"] is True
    assert (card["your_games"], card["opponent_games"]) == (2, 0)
    assert card["next_game_number"] is None, "there is no next game to deep-link"

    (row,) = event["fixtures"]
    assert row["state"] == "completed"
    assert row["you_won"] is True
    assert row["detail"] == "Won 2–0"

    loser_event = loser_panel["events"][0]
    assert (loser_event["wins"], loser_event["losses"]) == (0, 1)
    assert loser_event["position"] == 2
    assert loser_event["fixtures"][0]["detail"] == "Lost 0–2", (
        "the loser's own row reads as a loss — the row is stated from each side"
    )


async def test_the_card_prefers_the_live_match_over_a_finished_one(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """A player mid-match must never have to scroll past a result to find the game
    they are standing at a table for: with one match finished and another called, the
    card shows the one being played.

    Three-player group so the caller has two fixtures and the choice is real — with a
    single fixture the priority rule is unobservable, since whichever match exists is
    also the only one that could be picked.
    """
    client, owner = authed_client
    async with opponent_session(db_session, "prio-second") as (second_client, second):
        async with opponent_session(db_session, "prio-third") as (_third_client, third):
            tournament_id, (event,) = await _tournament_with_events(
                client,
                _rr_payload(
                    RESERVATION_A,
                    match_settings={"rated": False, "length_games": 3},
                    predicates=[],
                ),
            )
            entries = {
                user.username: await _enter(db_session, event["id"], user, seed=seed)
                for seed, user in enumerate((owner, second, third), start=1)
            }
            await _cut_the_draw(client, tournament_id, event["id"])
            await _set_status(db_session, tournament_id, TournamentStatus.published)
            assert (await _go_live(client, tournament_id)).status_code == 201

            fixtures = await _fixture_rows(db_session, event["id"])
            mine = [
                f
                for f in fixtures
                if entries[owner.username].id in (f.entry_a_id, f.entry_b_id)
            ]
            assert len(mine) == 2, "the caller plays both of the other two"
            finished, playing = mine
            await _call_fixtures(db_session, tournament_id, [finished, playing])
            reloaded = await _fixture_rows(db_session, event["id"])
            (finished,) = [f for f in reloaded if f.id == finished.id]
            await _win_fixture_match(
                finished,
                clients_by_entry={
                    entries[owner.username].id: client,
                    entries[second.username].id: second_client,
                },
                winner_entry_id=entries[owner.username].id,
                rated=False,
            )

            (panel,) = await _panels(client)

    card = panel["events"][0]["match"]
    assert card["state"] == "live", (
        "the called, unfinished match wins the card over the decided one"
    )
    assert card["match_id"] == str(playing.match_id)
    assert panel["events"][0]["fixtures"][0]["state"] == "completed", (
        "the finished match is still on the path — it is just not the card"
    )


async def test_an_uncalled_match_reads_as_the_next_one_up(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """A materialized-but-uncalled match is ``pending`` in the domain and
    ``scheduled`` on the panel: from the player's chair "not created yet" and "created
    but not called" are the same thing — a match they have not started — and the card
    must invite neither scoring nor a result."""
    client, owner = authed_client
    async with opponent_session(db_session, "uncalled-opp") as (_opp_client, opp):
        _tid, _event, _e_owner, _e_opp, fixture = await _live_two_player_group(
            client, owner, opp, db_session, rated=True, call=False
        )
        match = await db_session.get(Match, fixture.match_id)
        assert match is not None and match.status is MatchStatus.pending

        (panel,) = await _panels(client)

    assert panel["live_count"] == 0
    card = panel["events"][0]["match"]
    assert card["state"] == "scheduled"
    assert card["next_game_number"] is None, (
        "an uncalled match is not scorable, so there is no game to deep-link"
    )
    assert card["you_won"] is None
    assert panel["events"][0]["fixtures"][0]["state"] == "upcoming"


async def test_the_record_is_counted_directly_when_there_are_no_standings(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """``event_results`` answers ``None`` for every draw type but round-robin
    (ADR-0788), so the panel cannot read the record off a standings row there. It
    counts the caller's own decided fixtures instead.

    Proven by taking a real played round-robin and reading the record back with the
    standings projection removed — the state every future bracket event will be in.
    Without the direct count the panel reports ``0–0`` to a player who has won, and
    nothing type-checks or tests its way to noticing: the standings row is simply
    absent, and ``0`` is a perfectly well-formed number.
    """
    client, owner = authed_client
    async with opponent_session(db_session, "no-standings-opp") as (opp_client, opp):
        _tid, _event, e_owner, e_opp, fixture = await _live_two_player_group(
            client, owner, opp, db_session, rated=True
        )
        await _win_fixture_match(
            fixture,
            clients_by_entry={e_owner.id: client, e_opp.id: opp_client},
            winner_entry_id=e_owner.id,
            rated=True,
        )

        (with_standings,) = await _panels(client)
        assert (
            with_standings["events"][0]["wins"],
            with_standings["events"][0]["losses"],
        ) == (1, 0)

        # Now the same data with no standings to read — the bracket case.
        with patch("app.dashboard_tournaments.event_results", return_value=None):
            (without_standings,) = await _panels(client)

    event = without_standings["events"][0]
    assert (event["wins"], event["losses"]) == (1, 0), (
        "the record is counted from the caller's own decided fixtures, not zeroed"
    )
    assert event["position"] is None, (
        "and the position really is absent — the standings are what is missing"
    )


async def test_a_standing_result_owes_a_review_to_one_side_and_nothing_to_the_other(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """``owed_action`` is what the CALLER owes, and the two players owe opposite
    things once a result is standing.

    The panel used to read this off ``next_game_number is None``, which conflates
    three different states: the board is decided but unposted, a result is posted
    and awaiting acceptance, and the match is not in progress at all. Under that
    reading the card told BOTH players to "Post the result" — a job already done, and
    done by one of them. It comes from ``list_attention_kind`` now, the very
    classifier the attention panel on the same dashboard is built from, so the two
    panels cannot label one match two ways.
    """
    client, owner = authed_client
    async with opponent_session(db_session, "owed-opp") as (opp_client, opp):
        _tid, _event, _e_owner, _e_opp, fixture = await _live_two_player_group(
            client, owner, opp, db_session, rated=True
        )
        # Mid-board, nothing posted: both sides owe a score.
        (mine,) = await _panels(client)
        assert mine["events"][0]["match"]["owed_action"] == "score"

        # The owner proposes a decided board; it stands, unaccepted.
        post = await client.post(
            f"/v1/matches/{fixture.match_id}/results",
            json={
                "games": [
                    {"game_number": n, "side_1_points": 11, "side_2_points": 5}
                    for n in (1, 2)
                ]
            },
        )
        assert post.status_code == 201, post.text

        (poster_panel,) = await _panels(client)
        (reviewer_panel,) = await _panels(opp_client)

    assert poster_panel["events"][0]["match"]["owed_action"] == "waiting_opponent", (
        "the side that posted owes nothing — the move is the opponent's"
    )
    assert reviewer_panel["events"][0]["match"]["owed_action"] == "review", (
        "the other side owes a review, not another post"
    )
    assert poster_panel["events"][0]["match"]["next_game_number"] is None
    assert reviewer_panel["events"][0]["match"]["next_game_number"] is None, (
        "and next_game_number is None for BOTH — which is exactly why it cannot "
        "be the thing the label is read off"
    )


async def test_a_voided_match_shows_no_winner_and_no_score(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """A voided match contributes nothing (ADR-0013) — and the panel must say exactly
    that, not derive a result from it.

    Voiding nulls both sides' ``won`` precisely so that "any surface that derives a
    result must see *no winner*, not a stale W/L" (``app.match_voiding``). It also
    drops the match out of ``completed_match_ids``, so the panel has no game counts
    for it. Folding ``voided`` into ``completed`` therefore produced the worst of
    both: an outcome derived from an empty board, announcing ``Lost 0–0`` on a match
    the player may well have won before it was struck from the record.

    The match here is played to a real 2–0 win FIRST, then voided, so the test
    distinguishes "reports no result" from "had no result to report".
    """
    client, owner = authed_client
    async with opponent_session(db_session, "void-opp") as (opp_client, opp):
        _tid, _event, e_owner, e_opp, fixture = await _live_two_player_group(
            client, owner, opp, db_session, rated=True
        )
        await _win_fixture_match(
            fixture,
            clients_by_entry={e_owner.id: client, e_opp.id: opp_client},
            winner_entry_id=e_owner.id,
            rated=True,
        )
        match = await db_session.get(Match, fixture.match_id)
        assert match is not None
        await void_match(db_session, match)
        await db_session.commit()

        (panel,) = await _panels(client)

    event = panel["events"][0]
    card = event["match"]
    assert card["state"] == "voided", "not 'completed' — a void is its own state"
    assert card["you_won"] is None, (
        "a voided match has no winner, so the card crowns nobody"
    )

    (row,) = event["fixtures"]
    assert row["state"] == "voided"
    assert row["you_won"] is None
    assert row["detail"] == "Voided", (
        "the row states the fact rather than a fabricated 'Lost 0–0'"
    )
    assert (event["wins"], event["losses"]) == (0, 0), (
        "and the void counts toward neither column of the record"
    )


async def test_a_tournament_that_is_not_live_gets_no_panel(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """``live`` is the whole membership test. A published tournament has no draw being
    played yet and an archived one is over; neither belongs at the top of a
    dashboard."""
    client, owner = authed_client
    tournament_id, (event,) = await _tournament_with_events(
        client, _rr_payload(RESERVATION_A)
    )
    await _enter(db_session, event["id"], owner, seed=1)

    await _set_status(db_session, tournament_id, TournamentStatus.published)
    assert await _panels(client) == []

    await _set_status(db_session, tournament_id, TournamentStatus.live)
    assert len(await _panels(client)) == 1, "the same tournament, now live, is a panel"

    await _set_status(db_session, tournament_id, TournamentStatus.archived)
    assert await _panels(client) == []


async def test_a_withdrawn_player_gets_no_panel(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """Withdrawal is a soft delete (ADR-0016) — the row survives — so the panel has to
    filter on the status rather than on the row's existence, or a player who pulled out
    keeps being shown a tournament they are no longer in."""
    client, owner = authed_client
    tournament_id, (event,) = await _tournament_with_events(
        client, _rr_payload(RESERVATION_A)
    )
    entry = await _enter(db_session, event["id"], owner, seed=1)
    await _set_status(db_session, tournament_id, TournamentStatus.live)
    assert len(await _panels(client)) == 1

    await _withdraw_entry(db_session, entry)

    assert await _panels(client) == [], (
        "the withdrawn entry's row is still on the books, but it is not an entry"
    )


async def test_a_live_tournament_the_caller_only_directs_gets_no_panel(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """The panel is a PLAYER's surface, keyed on holding an entry — not on owning the
    tournament. A director who is running an event they are not playing in has no match
    to be shown, and their dashboard must not claim otherwise."""
    client, _owner = authed_client
    tournament_id, (event,) = await _tournament_with_events(
        client, _rr_payload(RESERVATION_A)
    )
    async with opponent_session(db_session, "entrant-not-owner") as (_c, entrant):
        await _enter(db_session, event["id"], entrant, seed=1)
        await _set_status(db_session, tournament_id, TournamentStatus.live)

        assert await _panels(client) == [], (
            "the owner created it, but they are not in it"
        )


async def test_an_event_with_no_draw_cut_stands_the_player_nowhere(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """``position: None`` is a fact, not a zero: an event whose draw has not been cut
    has no standings to stand in, and a ``0`` there would read as a rank."""
    client, owner = authed_client
    tournament_id, (event,) = await _tournament_with_events(
        client, _rr_payload(RESERVATION_A)
    )
    await _enter(db_session, event["id"], owner, seed=1)
    await _set_status(db_session, tournament_id, TournamentStatus.live)

    (panel,) = await _panels(client)

    (panel_event,) = panel["events"]
    assert panel_event["position"] is None
    assert panel_event["field_size"] == 0
    assert panel_event["match"] is None, "no fixtures, so there is no match to show"
    assert panel_event["fixtures"] == []
    assert panel_event["group_label"] is None, (
        "the caller has no fixture yet, so no group has been dealt to them"
    )


async def test_every_event_the_caller_entered_becomes_a_tab_of_one_panel(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """Two events of one tournament are two tabs of one panel, not two panels — the
    tournament is the thing the player is *at*, and its events are how they move around
    inside it."""
    client, owner = authed_client
    tournament_id, (first, second) = await _tournament_with_events(
        client,
        _rr_payload(RESERVATION_A, name="Open Singles"),
        _rr_payload(RESERVATION_A, name="U1500"),
    )
    await _enter(db_session, first["id"], owner, seed=1)
    await _enter(db_session, second["id"], owner, seed=1)
    await _set_status(db_session, tournament_id, TournamentStatus.live)

    (panel,) = await _panels(client)

    assert [event["name"] for event in panel["events"]] == ["Open Singles", "U1500"], (
        "tabs are in event-creation order, so the tab strip does not reshuffle "
        "between loads"
    )


def _dated_rr_payload(iso_date: str, **overrides: Any) -> dict[str, Any]:
    """A round-robin event dated ``iso_date`` — its own ``slot`` AND its
    reservation's ``slot`` share the date, since a reservation dated off its
    event's own date is refused (#1501, see ``test_tournaments.py``'s
    ``test_patch_event_by_creator_updates_jsonb``)."""
    return _rr_payload(
        {
            "name": "Reservation",
            "slot": {"date": iso_date, "start": "09:00", "end": "12:30"},
            "table_ids": [],
        },
        slot={"date": iso_date, "start": "09:00", "end": "18:00"},
        **overrides,
    )


async def test_the_panel_names_the_tournament_and_its_venue(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """The header's two lines. The subtitle folds venue and dates into one sentence
    server-side, because three optional facts assembled on each client would be
    assembled slightly differently on each.

    The range spans BOTH of the tournament's events (#1511), not just the one the
    caller entered — the panel's own entries/events are entered-only, so a range that
    reused them would silently narrow to the caller's own path. The caller's own
    event is dated a day EARLIER than the other, and is created SECOND: reusing the
    entered-events join would report "Jul 24" alone, and a wrong implementation that
    read creation order instead of a true min/max would report "Jul 25–24" — a
    backwards range — instead of reproducing this assertion."""
    client, owner = authed_client
    tournament_id, (_other_event, event) = await _tournament_with_events(
        client,
        _dated_rr_payload("2026-07-25", name="U1500"),
        _dated_rr_payload("2026-07-24", name="Open Singles"),
        name="Riverside Summer Slam",
    )
    await _enter(db_session, event["id"], owner, seed=1)
    await _set_status(db_session, tournament_id, TournamentStatus.live)

    (panel,) = await _panels(client)

    assert panel["id"] == tournament_id
    assert panel["name"] == "Riverside Summer Slam"
    assert panel["subtitle"].endswith("Jul 24–25"), (
        f"a same-month range collapses to one month name: {panel['subtitle']}"
    )


_PANEL_LOGGER = "app.dashboard_tournaments"


def _panel_logs(caplog: pytest.LogCaptureFixture) -> list[logging.LogRecord]:
    """Only this module's own records, so unrelated log noise from elsewhere in the
    request cannot make an "it logged" assertion pass — or an "it stayed quiet" one
    fail."""
    return [record for record in caplog.records if record.name == _PANEL_LOGGER]


async def test_a_tournament_with_no_venue_is_a_panel_of_dates_alone(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A tournament with no venue — announced before the room is booked, or
    deliberately withheld (CONTEXT.md, "Venue") — is a first-class state at every
    status, so its panel simply drops the venue half of the subtitle and shows the
    dates.

    And it logs **nothing**. This is the expected state, not a degradation: a line per
    dashboard load would train the reader to tune out the logger that the *corrupt*
    case (below) depends on being read."""
    client, owner = authed_client
    tournament_id, (event,) = await _tournament_with_events(
        client,
        _dated_rr_payload("2026-07-24"),
        name="Unbooked Open",
        address=None,
    )
    await _enter(db_session, event["id"], owner, seed=1)
    await _set_status(db_session, tournament_id, TournamentStatus.live)

    with caplog.at_level(logging.ERROR, logger=_PANEL_LOGGER):
        (panel,) = await _panels(client)

    assert panel["name"] == "Unbooked Open"
    assert panel["subtitle"] == "Jul 24", (
        "no venue means the date alone — not a leading separator, an empty segment, "
        "or a 'venue TBD' placeholder"
    )
    assert _panel_logs(caplog) == [], (
        "a venue-less tournament is normal and must not be reported as a problem"
    )


async def test_a_tournament_whose_stored_venue_is_corrupt_degrades_and_says_so(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """An address that does not parse must not take the dashboard down with it.

    The blast radius is what makes this worth a branch: the subtitle is one line of one
    panel, but a ``ValidationError`` here escapes the whole ``GET /v1/dashboard`` — one
    bad venue string would deny the caller their matches, their rating chart and their
    notifications. So the panel falls back to the dates and the page renders.

    **Both halves are asserted on purpose.** Containment alone would be satisfied by a
    bare ``except: pass``, which is precisely what we do not want: a silent fallback
    would swallow a serialization bug of *ours* — the nullable-address encoding going
    subtly wrong — and every dashboard would render no venue, green. So the ERROR, and
    the tournament id inside it, are part of the contract.

    The corrupt row is written directly, because no write path can produce one: create
    and edit both geocode, so a stored address always has its coordinates. This is a
    row that got that way by some other means, which is the only way it ever happens.
    """
    client, owner = authed_client
    tournament_id, (event,) = await _tournament_with_events(
        client,
        _dated_rr_payload("2026-07-24"),
        name="Corrupted Venue Open",
    )
    await _enter(db_session, event["id"], owner, seed=1)
    await _set_status(db_session, tournament_id, TournamentStatus.live)
    # Venue text but no coordinates: the half-populated address the schema exists to
    # rule out, so `Address` refuses it.
    await db_session.execute(
        update(Tournament)
        .where(Tournament.id == uuid.UUID(tournament_id))
        .values(address={"venue": "Riverside TTC"})
    )
    await db_session.commit()

    with caplog.at_level(logging.ERROR, logger=_PANEL_LOGGER):
        response = await client.get("/v1/dashboard")

    assert response.status_code == 200, response.text
    body = response.json()
    # The panels that have nothing to do with tournaments still came back — the point
    # of containing this rather than letting it escape.
    assert "rating" in body and "recent_results" in body

    (panel,) = body["tournaments"]
    assert panel["subtitle"] == "Jul 24", (
        "an unreadable venue degrades to the date, exactly like having no venue"
    )

    records = _panel_logs(caplog)
    assert len(records) == 1, (
        "containment must not become silence — a bare `except: pass` would satisfy "
        f"every assertion above this one; got {records}"
    )
    (record,) = records
    assert record.levelno == logging.ERROR
    assert tournament_id in record.getMessage(), (
        "the log must name WHICH tournament is corrupt, or it cannot be acted on"
    )


def test_no_events_means_no_date_segment_in_the_subtitle() -> None:
    """The dashboard panel itself can never show a tournament with zero events —
    an active entry, the panel's own membership test, requires an event to enter —
    so this branch is unreachable through the product. The pure formatting
    functions still have to answer it honestly, since ``_date_ranges`` (#1511)
    leaves an event-less tournament out of its returned dict entirely, and the
    caller reads that absence as ``None`` via ``.get(...)``: it composes to the
    venue alone, not a stray separator or an empty date segment."""
    tournament = Tournament(
        id=uuid.uuid4(),
        name="Ghost Open",
        status=TournamentStatus.live,
        address={
            "venue": "Riverside TTC",
            "street": "1 Main St",
            "city": "Chicago",
            "region": "IL",
            "postal": "60625",
            "country": "US",
            "latitude": 41.9,
            "longitude": -87.7,
        },
        league_id=uuid.uuid4(),
        created_by_user_id=uuid.uuid4(),
    )

    assert _format_date_range(None) is None
    assert _subtitle(tournament, None) == "Riverside TTC"

    # Neither venue nor dates composes to the empty string — not a lone separator
    # and not a "TBD" placeholder for either half.
    tournament.address = None
    assert _subtitle(tournament, None) == ""


async def test_a_withdrawn_entry_that_was_never_entered_is_not_a_uuid_lookup(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """A guard on the membership query itself: an entry row belonging to *another*
    user in the same live event must not put that event on this caller's panel."""
    client, _owner = authed_client
    tournament_id, (event,) = await _tournament_with_events(
        client, _rr_payload(RESERVATION_A)
    )
    async with opponent_session(db_session, "someone-else") as (_c, other):
        await _enter(
            db_session,
            event["id"],
            other,
            seed=1,
            status=TournamentEntryStatus.entered,
            entry_id=uuid.uuid4(),
        )
        await _set_status(db_session, tournament_id, TournamentStatus.live)

        assert await _panels(client) == []


# The pin, measured (print the statements below to re-measure): the caller's live
# entries — joined to their events, those events' tournaments AND, since #1086, those
# events' draw settings rows — plus ONE batched load of every event's stages
# (``TournamentEvent.stages``, ``lazy="selectin"`` too now, ADR 20260815 — the panel
# does not read them, but the relationship is eager for every reader, this one
# included) and ONE batched load of those tournaments' venue tables
# (``Tournament.tables``, ``lazy="selectin"`` — the catalogue is rows now,
# ADR 20260801, and the panel resolves a placement's table LABEL through it) and ONE of
# every event's groups (``TournamentEvent.groups``, ``lazy="selectin"`` — groups are
# rows now too, ADR 20260801, and the panel resolves a fixture's group LABEL through
# them) and ONE of every one of THOSE groups' reservations' table reservations
# (the reservation's ``tables``, ``lazy="selectin"`` — chained onto the groups' own
# batched load, so it is one statement per panel build and not one per group), ONE of
# every event's RESERVATIONS (``TournamentEvent.reservations``, ``lazy="selectin"``
# since #1387 — eager for every reader now that a group count no longer equals a
# reservation count; the panel does not read it) and ONE of those reservations'
# tables chained off it (the same rows as above, fetched once per path),
# then ONE batched load of every event's active entrants, ONE of every event's fixtures,
# ONE of the completed matches' game counts, ONE batched eager load of every event's
# STAGES (``TournamentEvent.stages``, ``lazy="selectin"`` — what
# ``_round_label``/``event_results`` read a fixture's ``stage_id`` against, in place of
# inferring a fixture's stage from the event's overall draw type plus
# ``group_id IS NULL``, ADR 20260815), ONE of the handful of focus matches, and that
# load's own eager options (the match's league, results, sides, settings, side
# players and those players' users — one batched ``selectin`` each), plus ONE more
# (#1511) — the batched ``MIN``/``MAX(slot->>'date')`` aggregate over every SHOWN
# tournament's full event set (``_date_ranges``), grouped by tournament id in a single
# statement regardless of how many tournaments the panel shows. It has to be its own
# query rather than reusing the entries/events already loaded above: those are the
# caller's ENTERED events only, and a tournament's date range spans ALL of its events.
# Eighteen, whatever the number of events (or tournaments — see
# ``test_panel_statement_count_does_not_grow_with_two_live_tournaments`` below).
EXPECTED_DASHBOARD_PANEL_STATEMENTS = 18


@pytest.mark.parametrize("event_count", [1, 3])
async def test_panel_statement_count_does_not_grow_with_events(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    engine: AsyncEngine,
    event_count: int,
) -> None:
    """The panel's round and stage wording is draw-type-dependent, and since #1086 the
    draw type lives on the event's ``draw_settings`` row rather than on a column of the
    event — so reading it is exactly the shape an N+1 takes: one SELECT per event, on
    the endpoint every signed-in player loads. It must cost none, and that is what the
    relationship's ``lazy="joined"`` buys: the settings row rides along in the query
    that already loads the event.

    The two ``event_count`` cases are what makes this discriminating. A per-event
    settings load emits one statement per event, so it would measure 13 at one event and
    15 at three — failing the pin at three even if it slipped past at one. The events
    alternate round-robin and single-elim, so both branches of the wording are exercised
    by the same payload, and the assertions below read the label off each.

    The second assertion names the failure directly rather than only counting: every
    statement that touches ``tournament_event_draw_settings`` must also name
    ``tournament_events``, i.e. be the join — a standalone lazy load of the settings
    table is the specific regression, and a future statement added elsewhere must not be
    able to absorb it under an unchanged total.

    Counted around the builder rather than the HTTP request, and on a fresh session, for
    the reasons ``counted_statements`` documents.
    """
    client, owner = authed_client
    user_id = owner.id  # read outside the counted block; see counted_statements
    async with opponent_session(db_session, "panel-n1-opp") as (_opp_client, opp):
        tournament_id, events = await _tournament_with_events(
            client,
            *[
                (
                    _rr_payload(RESERVATION_A, name=f"Round robin {n}")
                    if n % 2 == 0
                    else _event_payload(name=f"Bracket {n}", draw_type="single-elim")
                )
                for n in range(event_count)
            ],
        )
        base = datetime(2026, 6, 1, 9, 0, tzinfo=UTC)
        for event in events:
            await _enter(
                db_session,
                event["id"],
                owner,
                seed=1,
                created_at=base + timedelta(minutes=1),
            )
            await _enter(
                db_session,
                event["id"],
                opp,
                seed=2,
                created_at=base + timedelta(minutes=2),
            )
            await _cut_the_draw(client, tournament_id, event["id"])
        await _set_status(db_session, tournament_id, TournamentStatus.published)
        assert (await _go_live(client, tournament_id)).status_code == 201

        async with counted_statements(engine) as (session, statements):
            panels = await build_tournament_panels(session, user_id)

    for n, statement in enumerate(statements, start=1):
        print(f"[{n}] {' '.join(statement.split())}")

    assert len(statements) == EXPECTED_DASHBOARD_PANEL_STATEMENTS, statements
    assert not [
        s
        for s in statements
        if "tournament_event_draw_settings" in s and "tournament_events" not in s
    ], "a settings row was loaded on its own — the draw type became an N+1"

    # And the block it counted really did the work: every event is on the panel, and
    # each one's wording is its own draw type's.
    (panel,) = panels
    assert len(panel.events) == event_count
    for n, event in enumerate(panel.events):
        expected = "Group play" if n % 2 == 0 else "In play"
        assert event.stage_label == expected, (event.name, event.stage_label)
        assert event.match is not None
        assert event.match.round_label == (
            "Group match 1" if n % 2 == 0 else "Round 1"
        ), (event.name, event.match.round_label)
        # And no group label on a BRACKET, though its fixtures name a group row since
        # #1483. The panel asks the fixture's stage, not whether it resolved a group:
        # a bracket player has no group standings table and no group field, so "Group
        # A" would name both.
        assert event.group_label == ("Group A" if n % 2 == 0 else None), (
            event.name,
            event.group_label,
        )


async def test_panel_statement_count_does_not_grow_with_two_live_tournaments(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    engine: AsyncEngine,
) -> None:
    """The #1511 date-range aggregate is grouped by tournament id in ONE statement,
    not queried per tournament in a loop. That is exactly the shape a single
    tournament with several events (the parametrized case above) cannot discriminate:
    a per-tournament query in a loop still measures the pinned total at one
    tournament and would only fail once a second is added — which is what this test
    adds.

    Counted around the builder rather than the HTTP request, and on a fresh session,
    for the reasons ``counted_statements`` documents.
    """
    client, owner = authed_client
    user_id = owner.id  # read outside the counted block; see counted_statements
    async with opponent_session(db_session, "panel-2t-opp") as (_opp_client, opp):
        base = datetime(2026, 6, 1, 9, 0, tzinfo=UTC)
        tournament_ids = []
        for label in ("First Open", "Second Open"):
            tournament_id, (event,) = await _tournament_with_events(
                client, _rr_payload(RESERVATION_A, name="Open Singles"), name=label
            )
            await _enter(
                db_session,
                event["id"],
                owner,
                seed=1,
                created_at=base + timedelta(minutes=1),
            )
            await _enter(
                db_session,
                event["id"],
                opp,
                seed=2,
                created_at=base + timedelta(minutes=2),
            )
            await _cut_the_draw(client, tournament_id, event["id"])
            await _set_status(db_session, tournament_id, TournamentStatus.published)
            assert (await _go_live(client, tournament_id)).status_code == 201
            tournament_ids.append(tournament_id)

        async with counted_statements(engine) as (session, statements):
            panels = await build_tournament_panels(session, user_id)

    assert len(statements) == EXPECTED_DASHBOARD_PANEL_STATEMENTS, statements
    assert {panel.id for panel in panels} == {uuid.UUID(t) for t in tournament_ids}


async def test_a_swiss_panel_reads_the_callers_rank_off_the_group_less_table(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """A swiss event's results are one table over the whole field, with no group to key
    it by — so the panel has to read that shape, or a swiss player is shown no rank at
    all while the table carrying their row rides along on the same payload.

    Driven end to end over the smallest event that can finish: **two** players and one
    round. One pairing, and the caller wins it — which makes their rank a fact of the
    result rather than of a tiebreak. A four-player round would leave two winners level
    on wins who never met, separated by the entry-id fallback, so the test would pass or
    fail on which uuid the database minted. ``position`` comes off the standings row
    (counting the caller's own fixtures cannot produce a rank at all), and
    ``stage_label`` reads the event's own completeness rather than a group's, because
    swiss has no group whose flag could stand in.

    An **odd** field is deliberately not the subject: its byed entrant is seated in no
    fixture, so ``draw_currency_by_event`` reads the draw as stale and go-live refuses
    it (409) — the bye lands with the pairing, in its own slice.
    """
    client, owner = authed_client
    async with opponent_session(db_session, "swiss-panel-2") as (client_2, user_2):
        tournament_id, (event,) = await _tournament_with_events(
            client,
            _event_payload(
                draw_type="swiss",
                rounds=1,
                reservations=[],
                match_settings={"rated": False, "length_games": 3},
                predicates=[],
            ),
        )
        base = datetime(2026, 6, 1, 9, 0, tzinfo=UTC)
        entries = [
            await _enter(
                db_session,
                event["id"],
                user,
                seed=seed,
                created_at=base + timedelta(minutes=seed),
            )
            for seed, user in ((1, owner), (2, user_2))
        ]
        await _cut_the_draw(client, tournament_id, event["id"])
        await _set_status(db_session, tournament_id, TournamentStatus.published)
        assert (await _go_live(client, tournament_id)).status_code == 201
        clients = dict(
            zip(
                [entry.id for entry in entries],
                [client, client_2],
                strict=True,
            )
        )

        fixtures = await _fixture_rows(db_session, event["id"])
        await _call_fixtures(db_session, tournament_id, fixtures)
        fixtures = await _fixture_rows(db_session, event["id"])
        # One round of a two-player field is one fixture, and the caller is seed 1.
        (fixture,) = fixtures
        assert fixture.entry_a_id is not None
        await _win_fixture_match(
            fixture,
            clients_by_entry=clients,
            winner_entry_id=fixture.entry_a_id,
            rated=False,
        )

        (panel,) = await _panels(client)

    (swiss_event,) = panel["events"]
    assert swiss_event["draw_type"] == "swiss"
    assert swiss_event["position"] == 1, "the caller won the only match, so they lead"
    assert (swiss_event["wins"], swiss_event["losses"]) == (1, 0)
    assert swiss_event["stage_label"] == "Complete", (
        "the only round is decided, so the event is over — and swiss has no group "
        "whose completeness could have answered this instead"
    )
    assert swiss_event["group_label"] is None, (
        "the fixtures name the event's one group since #1483, but a swiss stage does "
        "not seat both sides at the cut, so the panel labels no group"
    )


async def test_an_rr_then_ko_panel_names_the_stage_each_fixture_is_in(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """A two-stage event's round wording is a property of the **fixture's stage**, not
    of the event (ADR 20260727).

    ``_round_label`` reads the discriminator off the fixture's own STAGE
    (``seats_both_sides_at_cut``), never ``group_id`` — since #1484 a knockout stage
    names its own group too, so ``group_id`` alone no longer tells a group-stage
    fixture from a bracket one. A group-stage fixture is a "Group match N", a
    knockout one a "Round N" — both vocabularies verbatim from the one-stage draw
    types, because the same match must not read differently depending on which event
    it happens to be in.

    Driven end to end: six players, two groups of three (the cut derives the count
    from the real field, #1387: ``ceil(6 / 5)``), top one out of each, so the group
    winners meet in a single final. The snake deals seeds 1, 4, 5 into group A and 2,
    3, 6 into group B; the LOWER seed always wins, so seeds 1 and 2 top their groups,
    and the only other winners (4 over 5, 3 over 6) are the two remaining sessions.
    The caller's card is asserted **twice** — once while a group match of theirs is
    the focus, once after the final has materialized — which is what makes this about
    the stage rather than about the event's draw type. ``stage_label`` stays minimal
    ("In play"), deliberately: naming which stage is live needs plumbing this ticket
    does not buy, and "Group complete" on an event whose bracket is still being played
    would announce it over.
    """
    client, owner = authed_client
    async with (
        opponent_session(db_session, "rrko-panel-2") as (client_2, user_2),
        opponent_session(db_session, "rrko-panel-3") as (client_3, user_3),
        opponent_session(db_session, "rrko-panel-4") as (client_4, user_4),
    ):
        tournament_id, (event,) = await _tournament_with_events(
            client,
            _rr_payload(
                RESERVATION_A,
                RESERVATION_B,
                draw_type="rr-then-ko",
                qualifiers_per_group=1,
                match_settings={"rated": False, "length_games": 3},
                predicates=[],
            ),
        )
        base = datetime(2026, 6, 1, 9, 0, tzinfo=UTC)
        players = {1: owner, 2: user_2, 3: user_3, 4: user_4}
        entries = {
            seed: await _enter(
                db_session,
                event["id"],
                players.get(seed) or await make_user(db_session, f"rrko-panel-{seed}"),
                seed=seed,
                created_at=base + timedelta(minutes=seed),
            )
            for seed in range(1, 7)
        }
        seed_by_entry = {entry.id: seed for seed, entry in entries.items()}
        await _cut_the_draw(client, tournament_id, event["id"])
        await _set_status(db_session, tournament_id, TournamentStatus.published)
        assert (await _go_live(client, tournament_id)).status_code == 201
        clients = {
            entries[1].id: client,
            entries[2].id: client_2,
            entries[3].id: client_3,
            entries[4].id: client_4,
        }

        # -- the group stage: a group match of the caller's is the focus, and it is a
        #    "Group match" (which round of the group's three is theirs first is the
        #    round-robin pairing's business, not this test's). Filtered by the
        #    fixture's own STAGE (#1484: the knockout stage now names a group too, so
        #    ``f.group_id`` alone no longer tells the two apart).
        def _is_group_stage(fixture: TournamentFixture) -> bool:
            return seats_both_sides_at_cut(fixture.stage.draw_type)

        groups = [
            f
            for f in await _fixture_rows(db_session, event["id"])
            if _is_group_stage(f)
        ]
        await _call_fixtures(db_session, tournament_id, groups)
        groups = [
            f
            for f in await _fixture_rows(db_session, event["id"])
            if _is_group_stage(f)
        ]
        (panel,) = await _panels(client)
        (group_event,) = panel["events"]
        assert group_event["match"]["round_label"].startswith("Group match ")
        assert group_event["stage_label"] == "In play"

        # -- both groups decided: each winner is seated into the final, which becomes a
        #    real match in the same transaction.
        for fixture in groups:
            assert fixture.entry_a_id is not None
            assert fixture.entry_b_id is not None
            await _win_fixture_match(
                fixture,
                clients_by_entry=clients,
                # The LOWER seed always wins, so each group's top one is its lowest
                # seed and every winner holds a session.
                winner_entry_id=min(
                    (fixture.entry_a_id, fixture.entry_b_id),
                    key=lambda entry_id: seed_by_entry[entry_id],
                ),
                rated=False,
            )

        (panel,) = await _panels(client)

    (ko_event,) = panel["events"]
    assert ko_event["draw_type"] == "rr-then-ko"
    assert ko_event["match"]["round_label"] == "Round 1", (
        "the knockout fixture is ungrouped, so it is a Round, not a Group match"
    )
    assert ko_event["match"]["opponent_username"] == "rrko-panel-2", (
        "the caller's final is against the other group's winner"
    )
    assert ko_event["stage_label"] == "In play"
    # The caller's path: their two group matches (a group of three plays two apiece)
    # and the final they were seated into.
    assert [row["label"] for row in ko_event["fixtures"]] == ["M1", "M2", "M3"]


async def test_the_path_list_sorts_by_scheduled_time_not_draw_order(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """#1297: "Your matches" reads top-to-bottom in the order the caller actually
    plays it, not in draw order (group -> round -> position, ADR-0786).

    A three-entrant round-robin group seats the caller (seed 1) into two of the
    draw's three rounds. Placed IN draw order they would already read correctly, so
    the fixtures are placed OUT of it on purpose — the later round scheduled for the
    earlier time, exactly the shape the issue reports (a noon ``M1`` ahead of a
    9 AM ``M2``) — and the panel must still list the 9 AM one first."""
    client, owner = authed_client
    async with (
        opponent_session(db_session, "sched-opp-2") as (_client_2, user_2),
        opponent_session(db_session, "sched-opp-3") as (_client_3, user_3),
    ):
        tournament_id, (event,) = await _tournament_with_events(
            client,
            _rr_payload(
                RESERVATION_A,
                match_settings={"rated": False, "length_games": 3},
                predicates=[],
            ),
        )
        base = datetime(2026, 6, 1, 9, 0, tzinfo=UTC)
        owner_entry, entry_2, entry_3 = [
            await _enter(
                db_session,
                event["id"],
                user,
                seed=seed,
                created_at=base + timedelta(minutes=seed),
            )
            for seed, user in ((1, owner), (2, user_2), (3, user_3))
        ]
        username_by_entry = {
            owner_entry.id: owner.username,
            entry_2.id: user_2.username,
            entry_3.id: user_3.username,
        }
        await _cut_the_draw(client, tournament_id, event["id"])
        await _set_status(db_session, tournament_id, TournamentStatus.published)
        assert (await _go_live(client, tournament_id)).status_code == 201

        rows = await _fixture_rows(db_session, event["id"])
        my_fixtures = sorted(
            (f for f in rows if owner_entry.id in (f.entry_a_id, f.entry_b_id)),
            key=lambda f: f.round,
        )
        assert len(my_fixtures) == 2, "seed 1 sits out exactly one of the 3 rounds"
        draw_first, draw_second = my_fixtures

        # Out of draw order: the fixture draw-ordered SECOND gets the EARLIER time.
        draw_first.scheduled_start = datetime(2026, 6, 1, 12, 0, tzinfo=UTC)
        draw_second.scheduled_start = datetime(2026, 6, 1, 9, 0, tzinfo=UTC)
        await db_session.commit()

        def opponent_of(fixture: TournamentFixture) -> str:
            other_id = (
                fixture.entry_b_id
                if fixture.entry_a_id == owner_entry.id
                else fixture.entry_a_id
            )
            assert other_id is not None
            return username_by_entry[other_id]

        (panel,) = await _panels(client)

    (event_out,) = panel["events"]
    assert [row["opponent_username"] for row in event_out["fixtures"]] == [
        opponent_of(draw_second),
        opponent_of(draw_first),
    ], (
        "the 9 AM fixture (draw-ordered second) must lead the path list ahead of "
        "the noon fixture (draw-ordered first) — time order, not draw order"
    )


async def test_untimed_fixtures_sort_last_and_keep_draw_order_among_themselves(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
) -> None:
    """A fixture with no time at all is not "soonest" by default — it sorts AFTER
    every timed fixture, and untimed fixtures keep their relative draw order among
    themselves (#1297).

    A four-entrant round-robin group seats the caller into all three rounds. Only
    the middle one is given a time; the other two stay unplaced and must still come
    out in draw order (round 1 before round 3), both trailing the one timed match."""
    client, owner = authed_client
    async with (
        opponent_session(db_session, "sched-opp-4b") as (_client_2, user_2),
        opponent_session(db_session, "sched-opp-4c") as (_client_3, user_3),
        opponent_session(db_session, "sched-opp-4d") as (_client_4, user_4),
    ):
        tournament_id, (event,) = await _tournament_with_events(
            client,
            _rr_payload(
                RESERVATION_A,
                match_settings={"rated": False, "length_games": 3},
                predicates=[],
            ),
        )
        base = datetime(2026, 6, 1, 9, 0, tzinfo=UTC)
        owner_entry, entry_2, entry_3, entry_4 = [
            await _enter(
                db_session,
                event["id"],
                user,
                seed=seed,
                created_at=base + timedelta(minutes=seed),
            )
            for seed, user in ((1, owner), (2, user_2), (3, user_3), (4, user_4))
        ]
        username_by_entry = {
            owner_entry.id: owner.username,
            entry_2.id: user_2.username,
            entry_3.id: user_3.username,
            entry_4.id: user_4.username,
        }
        await _cut_the_draw(client, tournament_id, event["id"])
        await _set_status(db_session, tournament_id, TournamentStatus.published)
        assert (await _go_live(client, tournament_id)).status_code == 201

        rows = await _fixture_rows(db_session, event["id"])
        my_fixtures = sorted(
            (f for f in rows if owner_entry.id in (f.entry_a_id, f.entry_b_id)),
            key=lambda f: f.round,
        )
        assert len(my_fixtures) == 3, "a 4-entrant group plays every round"
        round_1, round_2, round_3 = my_fixtures

        # Only the middle round gets a time; rounds 1 and 3 stay unplaced.
        round_2.scheduled_start = datetime(2026, 6, 1, 9, 0, tzinfo=UTC)
        await db_session.commit()

        def opponent_of(fixture: TournamentFixture) -> str:
            other_id = (
                fixture.entry_b_id
                if fixture.entry_a_id == owner_entry.id
                else fixture.entry_a_id
            )
            assert other_id is not None
            return username_by_entry[other_id]

        (panel,) = await _panels(client)

    (event_out,) = panel["events"]
    assert [row["opponent_username"] for row in event_out["fixtures"]] == [
        opponent_of(round_2),
        opponent_of(round_1),
        opponent_of(round_3),
    ], (
        "the timed fixture leads; the two untimed ones trail it in draw order "
        "(round 1 before round 3), not swapped or interleaved"
    )

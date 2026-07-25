"""Who gets hinted while a match is *in flight* — proposing and scoring.

``test_realtime_publishing`` covers the completion paths. This file covers the
two mid-match surfaces that complete nothing, and so are invisible to any hook
hung off ``finalize_match``:

- **a result is proposed** — the write that makes the opponent's "needs your
  attention" row appear, while the match itself stays ``in_progress``;
- **a game score is entered / updated / deleted** — the per-game chips on the
  dashboard's live tournament panel. Nothing is proposed and nothing is
  finalized, so without a hint of their own the panel freezes mid-match until
  somebody eventually posts a result.

Every test names the two participants who must be hinted **and** an uninvolved
signed-in user who must not be, asserting the bystander's list is exactly empty:
an implementation that broadcast to every connected user would pass a
"both players got a hint" assertion and fail only here. The fan-out is observed
at the broker (see :mod:`tests._realtime` for why never over the socket, and how
"zero" becomes an assertion instead of a hopeful sleep).

The writes are driven through the transport-neutral services rather than over
HTTP — matching ``test_result_proposal`` / ``test_match_scoring``, and pinning
the staging inside the service where the MCP tools and any future caller reach
it too, rather than in the router.
"""

import uuid
from dataclasses import dataclass

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker
from sqlalchemy.sql.base import ExecutableOption

from app.match_creation import create_match
from app.match_errors import NegotiationConflictError
from app.match_scoring import (
    delete_game_score,
    enter_game_score,
    load_match_for_write,
    update_game_score,
)
from app.models import Match, MatchResult, MatchStatus
from app.realtime import EventKind, RealtimeBroker
from app.result_chain import standing_result
from app.result_proposal import propose_result
from app.schemas.match import MatchResultsGameWrite
from tests._helpers import make_user, start_session
from tests._realtime import watch_hints

DASHBOARD = [EventKind.dashboard_changed]


def _name(stem: str) -> str:
    return f"{stem}-{uuid.uuid4().hex[:8]}"


@dataclass(frozen=True)
class Cast:
    """The three users every test needs — the two participants of ``match_id``
    and a signed-in bystander on neither side — as plain ids.

    Ids, not ORM instances, on purpose: the conflict test drives a path that
    rolls back, and a rollback expires every instance in the session, so reading
    ``user.id`` afterwards would emit a refresh from sync assertion code
    (``MissingGreenlet``) rather than the value we captured up front.
    """

    creator_id: uuid.UUID
    opponent_id: uuid.UUID
    bystander_id: uuid.UUID
    match_id: uuid.UUID

    @property
    def watched(self) -> tuple[uuid.UUID, uuid.UUID, uuid.UUID]:
        return (self.creator_id, self.opponent_id, self.bystander_id)


async def _cast(db: AsyncSession, tag: str, *, best_of: int = 5) -> Cast:
    creator = await make_user(db, _name(f"{tag}-creator"))
    opponent = await make_user(db, _name(f"{tag}-opponent"))
    bystander = await make_user(db, _name(f"{tag}-bystander"))
    match = await create_match(
        db,
        creator=creator,
        opponent_user_id=opponent.id,
        league_id=None,
        best_of=best_of,
        rated=True,
    )
    return Cast(creator.id, opponent.id, bystander.id, match.id)


def _decisive_board() -> list[MatchResultsGameWrite]:
    """A single decided game for a best-of-1 board, taken by side 1."""
    return [MatchResultsGameWrite(game_number=1, side_1_points=11, side_2_points=4)]


# ----- proposing -----------------------------------------------------------


async def test_proposing_a_result_hints_the_opponent_who_now_owes_a_review(
    db_session: AsyncSession,
    realtime_broker: RealtimeBroker,
) -> None:
    """The proposal itself — not the later acceptance — is what puts the "needs
    your attention" row on the other side's dashboard, so both participants are
    hinted while the match is still ``in_progress``. The bystander, signed in and
    connected, is hinted exactly zero times."""
    cast = await _cast(db_session, "propose", best_of=1)

    async with watch_hints(realtime_broker, *cast.watched) as watch:
        outcome = await propose_result(
            db_session,
            cast.match_id,
            cast.creator_id,
            games=_decisive_board(),
            supersedes_result_id=None,
        )
        hints = await watch.collect()

    # The point of the surface: nothing completed, the opponent merely owes a
    # review — a completion-only hook would publish nothing here.
    assert outcome.awaiting_acceptance is True
    assert outcome.match.status is MatchStatus.in_progress

    assert hints[cast.creator_id] == DASHBOARD
    assert hints[cast.opponent_id] == DASHBOARD
    assert hints[cast.bystander_id] == []


async def test_a_counter_that_loses_the_negotiation_race_publishes_nothing(
    db_session: AsyncSession,
    engine: AsyncEngine,
    realtime_broker: RealtimeBroker,
) -> None:
    """Propose stages its hints *before* the commit that can still fail.

    When two counters race to supersede the same proposal, the loser's commit
    trips ``uq_match_results_supersedes_result_id``, rolls back, and re-raises as
    a negotiation conflict. Nothing was proposed, so nobody may be told anything
    — the outbox's ``after_soft_rollback`` discard is what makes staging early
    safe, and this is the test that would red if the hints were published by hand
    after the fact instead.

    The race is made deterministic by letting the competing counter land between
    this call's read and its commit: the injected loader reads the match (leaving
    the in-memory chain one counter stale, so the pre-commit gate still passes),
    then commits the rival row on its own session.
    """
    cast = await _cast(db_session, "counter-race", best_of=1)
    first = await propose_result(
        db_session,
        cast.match_id,
        cast.creator_id,
        games=_decisive_board(),
        supersedes_result_id=None,
    )
    standing = standing_result(first.match)
    assert standing is not None

    async def racing_loader(
        db: AsyncSession,
        match_id: uuid.UUID,
        user_id: uuid.UUID,
        /,
        *,
        lock: bool,
        nowait: bool = False,
        options: tuple[ExecutableOption, ...] | None = None,
    ) -> Match:
        # Deliberately unlocked: the real ``FOR UPDATE`` would make the rival
        # session's FK-checking INSERT block on this transaction forever.
        match = await load_match_for_write(
            db, match_id, user_id, lock=False, options=options
        )
        async with async_sessionmaker(engine, expire_on_commit=False)() as rival:
            rival.add(
                MatchResult(
                    match_id=match_id,
                    submitted_by_user_id=cast.creator_id,
                    games=[{"game_number": 1, "side_1_points": 11, "side_2_points": 7}],
                    supersedes_result_id=standing.id,
                )
            )
            await rival.commit()
        return match

    async with watch_hints(realtime_broker, *cast.watched) as watch:
        with pytest.raises(NegotiationConflictError):
            await propose_result(
                db_session,
                cast.match_id,
                cast.opponent_id,
                games=[
                    MatchResultsGameWrite(
                        game_number=1, side_1_points=4, side_2_points=11
                    )
                ],
                supersedes_result_id=standing.id,
                load_match=racing_loader,
            )
        hints = await watch.collect()

    assert hints[cast.creator_id] == []
    assert hints[cast.opponent_id] == []
    assert hints[cast.bystander_id] == []


# ----- scoring -------------------------------------------------------------


def _assert_still_in_progress(match: Match) -> None:
    """The whole reason the score writes need hints of their own: they complete
    nothing, so no completion hook fires for them."""
    assert match.status is MatchStatus.in_progress
    assert match.completed_at is None
    assert match.results == []


async def test_entering_a_game_score_mid_match_hints_both_players(
    db_session: AsyncSession,
    realtime_broker: RealtimeBroker,
) -> None:
    """Game 1 of a best-of-5: the match is nowhere near over, but both players'
    dashboards now show a different score. The bystander sees nothing."""
    cast = await _cast(db_session, "enter")

    async with watch_hints(realtime_broker, *cast.watched) as watch:
        updated = await enter_game_score(
            db_session,
            cast.match_id,
            cast.creator_id,
            game_number=1,
            side_1_points=11,
            side_2_points=4,
        )
        hints = await watch.collect()

    _assert_still_in_progress(updated)
    assert hints[cast.creator_id] == DASHBOARD
    assert hints[cast.opponent_id] == DASHBOARD
    assert hints[cast.bystander_id] == []


async def test_updating_a_game_score_hints_both_players(
    db_session: AsyncSession,
    realtime_broker: RealtimeBroker,
) -> None:
    """Correcting an already-saved game is the same live change to the same two
    scoreboards."""
    cast = await _cast(db_session, "update")
    await enter_game_score(
        db_session,
        cast.match_id,
        cast.creator_id,
        game_number=1,
        side_1_points=11,
        side_2_points=4,
    )

    async with watch_hints(realtime_broker, *cast.watched) as watch:
        updated = await update_game_score(
            db_session,
            cast.match_id,
            cast.opponent_id,
            game_number=1,
            side_1_points=11,
            side_2_points=9,
            expected_version=1,
        )
        hints = await watch.collect()

    _assert_still_in_progress(updated)
    assert hints[cast.creator_id] == DASHBOARD
    assert hints[cast.opponent_id] == DASHBOARD
    assert hints[cast.bystander_id] == []


async def test_deleting_a_game_score_hints_both_players(
    db_session: AsyncSession,
    realtime_broker: RealtimeBroker,
) -> None:
    """Clearing a game takes the chip back off both dashboards, which is just as
    much a change as writing it."""
    cast = await _cast(db_session, "delete")
    await enter_game_score(
        db_session,
        cast.match_id,
        cast.creator_id,
        game_number=1,
        side_1_points=11,
        side_2_points=4,
    )

    async with watch_hints(realtime_broker, *cast.watched) as watch:
        updated = await delete_game_score(
            db_session,
            cast.match_id,
            cast.creator_id,
            game_number=1,
        )
        hints = await watch.collect()

    _assert_still_in_progress(updated)
    # The MatchGame row survives so a fresh score can attach to the same number.
    # Not ``next(genexp)``: the row being *gone* is the regression this line
    # exists to catch, and inside a coroutine a bare ``StopIteration`` surfaces
    # as ``RuntimeError: coroutine raised StopIteration``, which names neither.
    surviving = [g for g in updated.games if g.game_number == 1]
    assert len(surviving) == 1, (
        "deleting the score deleted the MatchGame row for game 1 — a fresh "
        "score can no longer attach to the same number. Games now: "
        f"{sorted(g.game_number for g in updated.games)}"
    )
    assert surviving[0].score is None
    assert hints[cast.creator_id] == DASHBOARD
    assert hints[cast.opponent_id] == DASHBOARD
    assert hints[cast.bystander_id] == []


# ----- creating ------------------------------------------------------------


async def test_creating_a_match_hints_both_participants(
    api_client: AsyncClient,
    db_session: AsyncSession,
    realtime_broker: RealtimeBroker,
) -> None:
    """Match creation is the *first* thing that puts a row in someone's "needs
    your attention" panel, and it went unhinted: the opponent's dashboard sat
    there showing nothing until they happened to navigate, while a reload showed
    the row had been there all along.

    Driven over HTTP rather than through the service, because this is the seam
    the bug lived in — the fan-out map covered every later write on a match and
    skipped the one that creates it. The uninvolved third user is signed in and
    connected, and is hinted exactly zero times.
    """
    creator = await start_session(api_client, db_session)
    opponent = await make_user(db_session, _name("created-opponent"))
    bystander = await make_user(db_session, _name("created-bystander"))

    async with watch_hints(
        realtime_broker, creator.id, opponent.id, bystander.id
    ) as watch:
        response = await api_client.post(
            "/v1/matches",
            json={
                "opponent_user_id": str(opponent.id),
                "best_of": 5,
                "rated": True,
            },
        )
        hints = await watch.collect()

    assert response.status_code == 201
    assert hints[creator.id] == DASHBOARD
    assert hints[opponent.id] == DASHBOARD
    assert hints[bystander.id] == []


async def test_creating_a_solo_match_hints_only_its_creator(
    api_client: AsyncClient,
    db_session: AsyncSession,
    realtime_broker: RealtimeBroker,
) -> None:
    """A solo match's side 2 is a player-less sentinel, so it contributes no
    hint — the staging iterates the players it has rather than indexing
    ``players[0]``."""
    creator = await start_session(api_client, db_session)
    bystander = await make_user(db_session, _name("solo-bystander"))

    async with watch_hints(realtime_broker, creator.id, bystander.id) as watch:
        response = await api_client.post(
            "/v1/matches", json={"best_of": 3, "rated": False}
        )
        hints = await watch.collect()

    assert response.status_code == 201
    assert hints[creator.id] == DASHBOARD
    assert hints[bystander.id] == []


async def test_a_refused_match_creation_hints_nobody(
    api_client: AsyncClient,
    db_session: AsyncSession,
    realtime_broker: RealtimeBroker,
) -> None:
    """The staging sits before the commit, so a creation that never happens
    tells nobody it did — the outbox's ``after_soft_rollback`` discard, seen from
    the route. A rated match with no registered opponent is refused by the
    service before anything is written."""
    creator = await start_session(api_client, db_session)

    async with watch_hints(realtime_broker, creator.id) as watch:
        response = await api_client.post(
            "/v1/matches", json={"best_of": 5, "rated": True}
        )
        hints = await watch.collect()

    assert response.status_code == 422
    assert hints[creator.id] == []

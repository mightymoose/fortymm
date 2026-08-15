"""Materializing ready fixtures into real matches (ADR-0788).

A **fixture** is a planned pairing; a **match** is the real, playable thing it becomes.
Materialization is the crossing: at go-live, every *ready* round-robin fixture — both
sides known, no match yet — is turned into a scheduled ``pending`` match and linked
back to its fixture by ``fixture.match_id`` (ADR-0788, amended by the "born scheduled,
goes live when called" ADR — the call flips it to ``in_progress``).

The pure planning half lives in ``app.draws`` (which fixtures are ready), the fixture
persistence in ``app.tournament_draws`` (the rows, and the ORM↔domain ``fixture_state``
bridge); this module owns only the one thing neither does — building a ``Match`` +
``MatchSettings`` + two ``MatchSide``\\ s out of a fixture and the event's rules.

The dependency points **one way**: this imports the match models and the draw layer,
and is imported by the tournament transition (``app.tournaments``). Nothing in the match
domain imports it, so the completion seam (#789) can import *this* without a cycle.
"""

import uuid
from collections.abc import Sequence

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.draws import (
    OrderedEntrant,
    Side,
    SideFill,
    order_entrants,
    reads_entrants,
    reads_fixture_games,
    reads_stage_position,
    ready_fixtures,
)
from app.models import (
    Match,
    MatchSettings,
    MatchSide,
    MatchSidePlayer,
    MatchStatus,
    Tournament,
    TournamentEntry,
    TournamentEvent,
    TournamentFixture,
)
from app.schemas.tournament import MatchSettings as EventMatchSettings
from app.tournament_draws import (
    active_draw_entrants,
    fixture_state,
    pool_order,
    stage_order,
    strategy_for_event,
)
from app.tournament_queries import game_counts_by_match, stage_ids_for_events


async def materialize_live_draw(db: AsyncSession, tournament: Tournament) -> None:
    """The go-live transition's final act (ADR-0788, amended): consume the first
    ``advance()`` of every event's draw, turning each **ready** fixture into a scheduled
    ``pending`` match (it goes live when the schedule calls it — see chore 1b).

    For round-robin this is the whole pool at once — every pairing is known at the cut,
    so a freshly-cut draw's ``advance()`` reports every fixture ready — and it is a
    one-time crossing: a fixture that already has a ``match_id`` is never ready again
    (``app.draws.ready_fixtures`` excludes it), so materialization is **idempotent** on
    ``match_id``, and re-running it materializes nothing.

    Runs inside the transition's row lock and transaction — the go-live precondition
    (``_enforce_ready_to_go_live``) has already guaranteed every event has a current
    draw, so the fixtures read here seat exactly the field the matches are created for.
    Does **not** commit: the caller (the transition) owns the transaction, so the status
    write and the matches it creates land together or not at all.
    """
    events = (
        (
            await db.execute(
                select(TournamentEvent).where(
                    TournamentEvent.tournament_id == tournament.id
                )
            )
        )
        .scalars()
        .all()
    )
    for event in events:
        await materialize_event(db, tournament, event)


async def materialize_event(
    db: AsyncSession, tournament: Tournament, event: TournamentEvent
) -> None:
    """Materialize the ready fixtures of one event.

    ``advance()`` — not a hand-rolled "both sides known?" — decides what is ready, so
    the one definition of readiness (both sides known, no match yet, not decided) is
    honoured here exactly as everywhere else. Shared by the two paths that advance a
    draw: go-live materialization (#788) and the completion seam
    (``app.tournament_advancement``, #789), which re-runs it after every result so a
    fixture made ready by a decided one becomes a match at once.

    It applies ``advance()``'s ``side_fills`` **before** deciding readiness, then
    recomputes readiness (via ``app.draws.ready_fixtures`` — the same helper
    ``advance()`` reports in ``ready_fixture_ids``) over the now-filled state so a
    fixture the fills just made whole (single-elim seating a decided fixture's winner
    onto its successor, #785) is materialized into a match in the **same** transaction.
    For round-robin the plan carries no side-fills at all (every pairing is known at the
    cut), so that step is a no-op and its behaviour is byte-identical.

    **The projection loads the fixtures' game counts — but only for the draw types that
    read them**, and that is load-bearing rather than defensive.
    ``FixtureState.games`` is what a pools-then-knockout draw picks its
    qualifiers by — the same tiebreak chain (wins → head-to-head → game difference →
    games won) the standings on screen are ordered by (ADR 20260727) — and this seam is
    the *only* place its ``advance()`` is ever run. Projected without them, every
    fixture reaching ``advance()`` carries ``games=None``: the strategy refuses loudly
    (``MissingFixtureGames``) rather than seating qualifiers computed on wins alone, so
    the failure is not silent — but the correct outcome is that a pool finishes and its
    qualifiers are seated, and that needs the counts. One batched load for the event,
    beside the fixture load, exactly as the read path batches it per page
    (``app.tournament_queries.game_counts_by_match``); reading them inside
    ``fixture_state`` would be a query per fixture.

    The strategy is therefore chosen **before** the counts are loaded, and the load is
    gated on ``app.draws.reads_fixture_games``. Round-robin and single-elim never look
    at the field, so for them the load was a few hundred score rows fetched and
    discarded — on the completion seam, once per result submission, inside the
    score-accept transaction under the match row lock. The gate is an exhaustive
    ``match`` over the draw type with no catch-all, so a new one cannot arrive here
    having quietly opted out of a load its strategy needs.

    **The event's entrants are loaded the same way, behind the same kind of gate**
    (``app.draws.reads_entrants``). ``advance()`` takes the field as well as the
    fixtures because for swiss the two are not the same thing: a bye is the absence of a
    fixture row, so its byed entrant — and a latecomer the currency check tolerates —
    is in no row at all, and a next round paired from the rows would leave them out of
    the event permanently. Only swiss declares it, so the other three still cost exactly
    the one fixture statement they always cost.
    """
    (
        fixtures,
        completed_match_ids,
        voided_match_ids,
    ) = await _fixtures_with_match_statuses(db, event.id)
    if not fixtures:
        # An event with no draw materializes nothing — but go-live's precondition means
        # this is unreachable on that path (every event has a current draw). Guarding it
        # keeps the function honest for a future caller that has no such precondition.
        return
    strategy = strategy_for_event(event)
    game_counts = (
        await game_counts_by_match(db, completed_match_ids)
        if reads_fixture_games(event.draw_settings.draw_type)
        else {}
    )
    # The event's pool order, resolved once and handed to every projection: it is what
    # fills ``FixtureState.pool_position``, and so what makes an ``advance()`` plan's
    # ready list run pool 1, 2, … 10 rather than the ids' 1, 10, 2 (ADR 20260801).
    pools = pool_order(event)
    # The event's STAGE order, resolved the same way and gated the same way as the
    # game counts and the field above: it fills ``FixtureState.stage_position``, which
    # is what lets ``RrThenKoStrategy`` split its event's fixtures between its two
    # stages without re-deriving the split from ``pool_id is None`` (ADR 20260815
    # decision 6). Only it declares ``reads_stage_position`` — the other three draw
    # types are one stage each and would pay a round trip for a field they discard.
    stages = (
        await stage_order(db, event.id)
        if reads_stage_position(event.draw_settings.draw_type)
        else {}
    )
    # The **field**, beside the fixtures, for the one draw type that cannot recover it
    # from them: a swiss bye is the absence of a fixture row, so pairing the next round
    # from the seated set alone would drop the byed entrant out of the event. Read
    # through the same pair the cut reads it through — ``active_draw_entrants`` then
    # ``order_entrants`` — so the field a draw is advanced against is the field it was
    # cut from, by construction rather than by two loaders agreeing. Gated exactly as
    # the game counts are, and for the same reason: on the completion seam this is a
    # round trip per result submission, and three of the four draw types would discard
    # it (``app.draws.reads_entrants``).
    entrants: Sequence[OrderedEntrant] = (
        order_entrants(await active_draw_entrants(db, event.id))
        if reads_entrants(event.draw_settings.draw_type)
        else ()
    )
    plan = strategy.advance(
        [
            fixture_state(f, game_counts, voided_match_ids, pools, stages)
            for f in fixtures
        ],
        entrants,
    )
    # Apply the side-fills a decided fixture implies BEFORE the readiness pass, so a
    # fixture made whole by them seats its match in this same transaction. A fill only
    # ever seats a still-empty side (``advance()`` never plans one over a filled side,
    # and ``_apply_side_fill``'s guard makes a re-application a no-op), which is what
    # keeps the whole advance idempotent; round-robin plans no fills, so this loop does
    # nothing and its materialization is unchanged.
    fixtures_by_id = {fixture.id: fixture for fixture in fixtures}
    for fill in plan.side_fills:
        _apply_side_fill(fixtures_by_id[fill.fixture_id], fill)
    # Readiness is decided by ``ready_fixtures`` — the shared helper ``advance()``
    # itself returns as ``ready_fixture_ids``, not a hand-rolled "both sides known?" —
    # now over the just-filled state, so the one definition of readiness is honoured and
    # a fixture the fills completed is seen ready here. Fills only add sides (never a
    # match or a winner), so this recomputed ready set is a superset of the first
    # plan's and needs no second side-fill pass beyond the loop above.
    ready = set(
        ready_fixtures(
            [
                fixture_state(f, game_counts, voided_match_ids, pools, stages)
                for f in fixtures
            ]
        )
    )
    ready_fixture_rows = [f for f in fixtures if f.id in ready]
    if not ready_fixture_rows:
        return

    entry_users = await _entry_user_ids(db, ready_fixture_rows)
    settings = EventMatchSettings.model_validate(event.match_settings)
    built: list[tuple[TournamentFixture, Match]] = []
    for fixture in ready_fixture_rows:
        # A ready fixture always has both sides known (that is what "ready" means); the
        # guard narrows the Optional for the type checker and can never actually skip a
        # fixture ``advance()`` reported ready.
        if fixture.entry_a_id is None or fixture.entry_b_id is None:
            continue
        match = _build_match(
            tournament,
            settings,
            side_1_user_id=entry_users[fixture.entry_a_id],
            side_2_user_id=entry_users[fixture.entry_b_id],
        )
        db.add(match)
        built.append((fixture, match))

    # Insert the matches BEFORE writing ``fixture.match_id``: the fixture's FK
    # (``ON DELETE SET NULL``) points at ``matches``, and there is no ORM relationship
    # on the fixture for the unit-of-work to infer that ordering from — so without an
    # explicit flush the fixture UPDATE can race ahead of the match INSERT and trip the
    # foreign key. One flush for the whole event's matches, then the links.
    await db.flush()
    for fixture, match in built:
        fixture.match_id = match.id


async def _fixtures_with_match_statuses(
    db: AsyncSession, event_id: uuid.UUID
) -> tuple[list[TournamentFixture], list[uuid.UUID], frozenset[uuid.UUID]]:
    """This event's fixtures, the ids of the matches among them that are **currently
    completed**, and the ids of the ones that are **voided** — in ONE statement.

    The status rides along on the fixture load rather than being asked for separately:
    a fixture's match is reached by an outer join (outer, because most fixtures have no
    match yet, and a fixture that lost its link — ``match_id`` is ``ON DELETE SET NULL``
    — must still be returned), and the ``completed`` filter is applied in Python over
    rows already in hand. Exactly what the read path does with the same two facts
    (:func:`app.tournament_queries.completed_match_ids` filters an already-loaded
    ``match_status``); the write seam has no reason to pay a round trip the read seam
    does not.

    The ``completed`` filter is the contract, not an optimization. An in-progress
    match's part-scored board is not a result; a fixture whose match has not completed
    projects ``games=None`` and its pool is simply not finished yet, which is exactly
    how a result under correction un-finishes the pool it was in rather than freezing a
    stale qualifier list (ADR 20260727).

    The completed ids are handed to
    :func:`app.tournament_queries.game_counts_by_match` — the same loader the read path
    projects standings through, so the qualifiers a draw seats and the table a director
    is reading are counted by one implementation — and only when the draw type reads
    them at all.

    The **voided** ids are the other half of the same fact, and they are collected
    unconditionally: they cost nothing (the status is already in hand), and no draw type
    can afford to be blind to them. A voided pairing can never produce a result, so a
    strategy that treated it as a missing score would hold its pool permanently
    unfinished — one score short forever — while the standings, which exclude voided
    pairings from a pool's ``fixture_count``, showed that same pool ``complete``
    (:attr:`app.draws.FixtureState.match_voided`).
    """
    rows = (
        await db.execute(
            select(TournamentFixture, Match.status)
            .outerjoin(Match, Match.id == TournamentFixture.match_id)
            # ``event_id`` no longer lives on the fixture (ADR 20260815 decision 5); the
            # event is reachable through the stage.
            .where(TournamentFixture.stage_id.in_(stage_ids_for_events([event_id])))
            # Ordered for **stability**, not for presentation: an unordered ``SELECT``
            # has no guarantee even between two runs against unchanged data, and the
            # rows go on to be projected into the outcomes a draw type ranks its field
            # by. Nothing downstream may depend on that order — the tiebreak chain is
            # sums and counts (``app.pool_finishing_order``), and a plan's ready list is
            # sorted by ``app.draws.ready_fixtures`` — but "no caller depends on it" is
            # cheaper to keep true when the order is fixed.
            #
            # ``(pool_id, round, position)`` is total within one event: it is the
            # fixture's identity there, declared NULLS NOT DISTINCT so the un-pooled
            # draws are covered too
            # (``uq_tournament_fixtures_event_id_pool_id_round_position``). It is the
            # read path's key (``app.tournament_queries.fixtures_by_event``) minus the
            # pool's *position*, which that path sorts on to render the draw in the
            # director's pool order — presentation this seam has no use for, and would
            # pay a correlated subquery for.
            .order_by(
                TournamentFixture.pool_id.asc().nulls_last(),
                TournamentFixture.round,
                TournamentFixture.position,
            )
        )
    ).all()
    fixtures: list[TournamentFixture] = []
    completed_match_ids: list[uuid.UUID] = []
    voided_match_ids: set[uuid.UUID] = set()
    for fixture, status in rows:
        fixtures.append(fixture)
        if fixture.match_id is None:
            continue
        if status is MatchStatus.completed:
            completed_match_ids.append(fixture.match_id)
        elif status is MatchStatus.voided:
            voided_match_ids.add(fixture.match_id)
    return fixtures, completed_match_ids, frozenset(voided_match_ids)


async def _entry_user_ids(
    db: AsyncSession, fixtures: Sequence[TournamentFixture]
) -> dict[uuid.UUID, uuid.UUID]:
    """Map each seated entry id to the user behind it — the user a materialized match
    seats on the corresponding side. One batched read for every entry in the ready set.
    """
    entry_ids: set[uuid.UUID] = set()
    for fixture in fixtures:
        if fixture.entry_a_id is not None:
            entry_ids.add(fixture.entry_a_id)
        if fixture.entry_b_id is not None:
            entry_ids.add(fixture.entry_b_id)
    rows = (
        await db.execute(
            select(TournamentEntry.id, TournamentEntry.user_id).where(
                TournamentEntry.id.in_(entry_ids)
            )
        )
    ).all()
    return {entry_id: user_id for entry_id, user_id in rows}


def _apply_side_fill(fixture: TournamentFixture, fill: SideFill) -> None:
    """Seat ``fill``'s entry onto the named side of ``fixture`` — but only if that side
    is still empty.

    The empty-side guard is what keeps re-running the advance a no-op: ``advance()``
    never plans a fill over a side it can already see filled, so a fill that finds one
    filled is a re-application of a plan already applied and must not overwrite it
    (least of all with a *different* entry). Side ``a`` ↔ ``entry_a_id`` and side ``b``
    ↔ ``entry_b_id`` — the same fixed convention the match's side 1 ← ``entry_a`` /
    side 2 ← ``entry_b`` seating reads back to map a winner to its entry (#788/#789).
    """
    if fill.side is Side.a:
        if fixture.entry_a_id is None:
            fixture.entry_a_id = fill.entry_id
    elif fixture.entry_b_id is None:
        fixture.entry_b_id = fill.entry_id


def _build_match(
    tournament: Tournament,
    settings: EventMatchSettings,
    *,
    side_1_user_id: uuid.UUID,
    side_2_user_id: uuid.UUID,
) -> Match:
    """The real match one ready fixture becomes (ADR-0788, amended) — built, not yet
    persisted.

    The match is born ``pending`` (*scheduled*): both players are known and committed,
    but a tournament match is not played on agreement — it is played when the schedule
    **calls it to a table**. The call (the *match_called* notification) is what flips it
    ``pending → in_progress``; until then it is scheduled, not live, and folds into the
    passive "waiting" attention bucket rather than flooding entrants with actionable
    "score" rows (the fix for issue #1073). It carries the
    **tournament's** league and is created by the tournament **owner** (a tournament
    match has no player-initiator — the director's go-live created it; the field grants
    no scoring rights, which are by side participation). Its ``MatchSettings`` copy the
    only two things the event holds — ``best_of ← length_games``, ``affects_rating ←
    rated`` — with ``team_size = 1`` and the model's default verification policy and
    retirement window (the event has nothing else to copy).

    **side 1 ← ``entry_a``, side 2 ← ``entry_b``** is a fixed convention, not a detail:
    it is what lets a completed match's winning ``side_number`` map back to the winning
    entry (1 → ``entry_a``, 2 → ``entry_b``) with no extra column (#789).
    """
    match = Match(
        match_settings=MatchSettings(
            team_size=1,
            best_of=settings.length_games,
            affects_rating=settings.rated,
        ),
        league_id=tournament.league_id,
        created_by_user_id=tournament.created_by_user_id,
        status=MatchStatus.pending,
    )
    _add_side(match, side_number=1, user_id=side_1_user_id)
    _add_side(match, side_number=2, user_id=side_2_user_id)
    return match


def _add_side(match: Match, *, side_number: int, user_id: uuid.UUID) -> None:
    """Attach one populated side to ``match`` (mirrors ``app.matches._add_side``).

    A tournament match always has two real players — there is no opponent-less sentinel
    side here — so every side carries exactly one ``MatchSidePlayer``. Wiring the
    ``match`` relationship on both the side and the side-player is what populates their
    denormalized ``match_id`` columns on flush.
    """
    side = MatchSide(match=match, side_number=side_number)
    side.players.append(MatchSidePlayer(match=match, user_id=user_id))

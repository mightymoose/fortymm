"""Coverage for ``app.retirement_jobs`` — the sweep that auto-accepts a
standing match result once its retirement window has lapsed."""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from rq import Queue
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

import app.retirement_jobs as retirement_jobs
from app.models import (
    League,
    Match,
    MatchGame,
    MatchGameScore,
    MatchResult,
    MatchSettings,
    MatchSide,
    MatchSidePlayer,
    MatchStatus,
    RatingHistory,
    User,
)
from app.notifications.service import NotificationService
from app.result_chain import standing_result
from app.retirement_jobs import (
    RetirementOutcome,
    _load_match,
    remind_if_due,
    retire_if_lapsed,
    sweep_due_reminders,
    sweep_lapsed_retirements,
)
from tests._helpers import FakeSender, enqueued_notification_jobs, make_user

# ----- helpers ------------------------------------------------------------


def _notifications(db: AsyncSession) -> NotificationService:
    """A worker-shaped notification service (no APNs, records enqueues on the
    autouse ``fake_notifications_queue``) to thread into the sweep entry points."""
    return NotificationService(db, FakeSender())


async def _uniq_user(db: AsyncSession, stem: str) -> User:
    return await make_user(db, f"{stem}-{uuid.uuid4().hex[:8]}")


async def _build_standing_match(
    db: AsyncSession,
    league: League,
    *,
    submitted_ago: timedelta,
    window: timedelta | None = timedelta(days=7),
) -> tuple[Match, MatchResult, User, User]:
    """Persist an in-progress, rated singles match with a decisive 11-4 game and
    a single **standing** (unaccepted) result at the head of the chain.

    ``submitted_ago`` back-dates ``submitted_at`` so the derived retirement
    deadline (``submitted_at + window``) is controllable without sleeping. The
    poster (submitter) is the side-1 player who won the game; side 2 owes
    acceptance.
    """
    poster = await _uniq_user(db, "poster")
    opponent = await _uniq_user(db, "opponent")

    settings = MatchSettings(
        team_size=1, best_of=1, affects_rating=True, retirement_window=window
    )
    match = Match(
        match_settings=settings,
        league=league,
        created_by_user_id=poster.id,
        status=MatchStatus.in_progress,
    )
    side1 = MatchSide(match=match, side_number=1)
    side1.players.append(MatchSidePlayer(match=match, user=poster.primary_player))
    side2 = MatchSide(match=match, side_number=2)
    side2.players.append(MatchSidePlayer(match=match, user=opponent.primary_player))
    game = MatchGame(match=match, game_number=1)
    game.score = MatchGameScore(side_1_points=11, side_2_points=4)
    result = MatchResult(
        match=match,
        submitted_for_player_id=poster.id,
        submitted_by_user_id=poster.id,
        games=[],
        submitted_at=datetime.now(UTC) - submitted_ago,
    )
    db.add(match)
    await db.commit()
    if window is None:
        # Passing ``None`` to the constructor lets the column's 7-day
        # server_default fill on INSERT; force the NULL with an explicit UPDATE.
        settings.retirement_window = None
        await db.commit()
    return match, result, poster, opponent


async def _rating_history_count(db: AsyncSession, match_id: uuid.UUID) -> int:
    return (
        await db.execute(
            select(func.count())
            .select_from(RatingHistory)
            .where(RatingHistory.match_id == match_id)
        )
    ).scalar_one()


# ----- (a) lapsed rated result retires + rates ----------------------------


async def test_retire_if_lapsed_accepts_and_completes_a_lapsed_rated_result(
    db_session: AsyncSession, default_league: League
) -> None:
    match, result, poster, opponent = await _build_standing_match(
        db_session, default_league, submitted_ago=timedelta(days=8)
    )

    outcome = await retire_if_lapsed(
        db_session, match.id, result.id, _notifications(db_session)
    )

    assert outcome is RetirementOutcome.retired
    await db_session.refresh(match)
    assert match.status is MatchStatus.completed
    # Acceptance was stamped by the *owing* side (opponent), not the poster.
    await db_session.refresh(result)
    assert result.accepted_by_user_id == opponent.id
    # A completed rated singles match applies exactly one rating pair.
    assert await _rating_history_count(db_session, match.id) == 2


# ----- (b) MANDATORY: old result_id vs a newer standing head → no-op ------


async def test_retire_with_superseded_result_id_is_a_noop(
    db_session: AsyncSession, default_league: League
) -> None:
    """Binds acceptance to the specific ``result_id`` (ADR 0007). If a counter
    superseded it inside the window, retiring the *old* id must do nothing — the
    match stays in progress and no ratings apply."""
    match, base, poster, opponent = await _build_standing_match(
        db_session, default_league, submitted_ago=timedelta(days=8)
    )
    match_id, base_id = match.id, base.id
    # Opponent counters: a new head supersedes ``base`` (both past the deadline).
    counter = MatchResult(
        match_id=match_id,
        submitted_for_player_id=opponent.id,
        submitted_by_user_id=opponent.id,
        games=[],
        supersedes_result_id=base_id,
        submitted_at=datetime.now(UTC) - timedelta(days=8),
    )
    db_session.add(counter)
    await db_session.commit()

    # The real job runs on its own fresh session; drop the shared session's
    # identity-map cache so the job's reload sees the newly-added counter.
    db_session.expire_all()
    outcome = await retire_if_lapsed(
        db_session, match_id, base_id, _notifications(db_session)
    )

    assert outcome is RetirementOutcome.superseded
    await db_session.refresh(match)
    assert match.status is MatchStatus.in_progress
    assert await _rating_history_count(db_session, match.id) == 0


# ----- (c) NULL retirement_window → not a candidate / deadline None -------


async def test_null_retirement_window_is_not_swept_and_never_due(
    db_session: AsyncSession, default_league: League
) -> None:
    match, result, _poster, _opponent = await _build_standing_match(
        db_session, default_league, submitted_ago=timedelta(days=8), window=None
    )
    match_id, result_id = match.id, result.id

    # The sweep filters on ``retirement_window IS NOT NULL``, so it's no candidate.
    db_session.expire_all()
    outcomes = await sweep_lapsed_retirements(db_session, _notifications(db_session))
    assert outcomes == []

    # And called directly, a None deadline reads as not-yet-due.
    outcome = await retire_if_lapsed(
        db_session, match_id, result_id, _notifications(db_session)
    )
    assert outcome is RetirementOutcome.not_yet_due
    await db_session.refresh(match)
    assert match.status is MatchStatus.in_progress


# ----- (d) deadline still in the future → no-op ---------------------------


async def test_future_deadline_is_not_yet_due(
    db_session: AsyncSession, default_league: League
) -> None:
    match, result, _poster, _opponent = await _build_standing_match(
        db_session, default_league, submitted_ago=timedelta(hours=1)
    )

    outcome = await retire_if_lapsed(
        db_session, match.id, result.id, _notifications(db_session)
    )

    assert outcome is RetirementOutcome.not_yet_due
    await db_session.refresh(match)
    assert match.status is MatchStatus.in_progress
    assert await _rating_history_count(db_session, match.id) == 0


# ----- (e) sweep picks up a lapsed match end-to-end -----------------------


async def test_sweep_retires_a_lapsed_match(
    db_session: AsyncSession, default_league: League
) -> None:
    match, result, _poster, _opponent = await _build_standing_match(
        db_session, default_league, submitted_ago=timedelta(days=8)
    )
    # A second, not-yet-due match must be left untouched by the same sweep.
    fresh, _fresh_result, _p2, _o2 = await _build_standing_match(
        db_session, default_league, submitted_ago=timedelta(hours=1)
    )

    outcomes = await sweep_lapsed_retirements(db_session, _notifications(db_session))

    assert outcomes == [RetirementOutcome.retired]
    await db_session.refresh(match)
    await db_session.refresh(fresh)
    assert match.status is MatchStatus.completed
    assert fresh.status is MatchStatus.in_progress
    # Once retired, the head is accepted, so nothing stands (reload eagerly so
    # ``standing_result`` can walk the results without a lazy load).
    reloaded = await _load_match(db_session, match.id)
    assert reloaded is not None
    assert standing_result(reloaded) is None


# ----- (f) idempotency under the lock: no double-apply --------------------


async def test_retiring_twice_applies_ratings_once(
    db_session: AsyncSession, default_league: League
) -> None:
    """A second retirement of the same (now-stale) result id — the shape a
    concurrent manual accept leaves behind once the lock is released — is a
    clean ``superseded`` no-op, so the rating pair is applied exactly once."""
    match, result, _poster, _opponent = await _build_standing_match(
        db_session, default_league, submitted_ago=timedelta(days=8)
    )
    match_id, result_id = match.id, result.id

    notifications = _notifications(db_session)
    first = await retire_if_lapsed(db_session, match_id, result_id, notifications)
    # The second call's no-op rolls back, which expires the session's objects.
    second = await retire_if_lapsed(db_session, match_id, result_id, notifications)

    assert first is RetirementOutcome.retired
    assert second is RetirementOutcome.superseded
    assert await _rating_history_count(db_session, match_id) == 2


async def test_retire_takes_the_match_row_lock(
    db_session: AsyncSession,
    default_league: League,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Structural guarantee that the acceptance happens under the row lock — the
    serialization that keeps a concurrent manual accept from double-applying
    ratings (issue #365). Spies on ``_lock_match_row`` so removing the lock would
    fail this test, not just the idempotency one above (which the guard alone
    would still pass)."""
    match, result, _poster, _opponent = await _build_standing_match(
        db_session, default_league, submitted_ago=timedelta(days=8)
    )
    match_id, result_id = match.id, result.id

    locked: list[uuid.UUID] = []
    original = retirement_jobs._lock_match_row

    async def _spy(db: AsyncSession, mid: uuid.UUID) -> None:
        locked.append(mid)
        await original(db, mid)

    monkeypatch.setattr(retirement_jobs, "_lock_match_row", _spy)

    outcome = await retire_if_lapsed(
        db_session, match_id, result_id, _notifications(db_session)
    )

    assert outcome is RetirementOutcome.retired
    assert locked == [match_id]


# ----- defensive: player-less owing side ----------------------------------


async def test_owing_side_without_players_is_a_noop(
    db_session: AsyncSession, default_league: League
) -> None:
    """A solo/sentinel match whose only other side has no players can't yield an
    acceptor; the job must no-op rather than IndexError. (Such matches carry no
    standing rated result in practice; this is belt-and-suspenders.)"""
    match, result, poster, opponent = await _build_standing_match(
        db_session, default_league, submitted_ago=timedelta(days=8)
    )
    match_id, result_id = match.id, result.id
    # Strip the owing side's players to model the sentinel shape.
    owing = next(s for s in match.sides if s.side_number == 2)
    for player in list(owing.players):
        await db_session.delete(player)
    await db_session.commit()

    db_session.expire_all()
    outcome = await retire_if_lapsed(
        db_session, match_id, result_id, _notifications(db_session)
    )

    assert outcome is RetirementOutcome.no_owing_side
    await db_session.refresh(match)
    assert match.status is MatchStatus.in_progress


# ----- #1523 constraint 1: submitter on neither side (director bypass) -----


async def test_owing_side_follows_player_when_actor_is_a_bystander(
    db_session: AsyncSession, default_league: League
) -> None:
    """Changing actor provenance does not change which sporting side owes acceptance."""
    match, result, poster, opponent = await _build_standing_match(
        db_session, default_league, submitted_ago=timedelta(days=8)
    )
    # Capture ids before ``expire_all()`` below — an expired ``poster.id``
    # access mid-assertion would trigger a synchronous lazy load (the
    # sibling tests in this module follow the same pattern for ``match``/
    # ``result``).
    match_id, result_id, opponent_id = match.id, result.id, opponent.id
    bystander = await _uniq_user(db_session, "bystander")
    # Re-point the standing result's submitter to someone on NEITHER side —
    # the state ``_requires_confirmation`` now prevents ``propose_result``
    # from ever producing.
    result.submitted_by_user_id = bystander.id
    await db_session.commit()

    db_session.expire_all()
    outcome = await retire_if_lapsed(
        db_session, match_id, result_id, _notifications(db_session)
    )

    # The represented Player still determines the owing side.
    assert outcome is RetirementOutcome.retired
    await db_session.refresh(result)
    assert result.accepted_by_user_id == opponent_id


# ----- notifications: retired-on-lapse notice -----------------------------


async def test_lapse_notifies_owing_side_only(
    db_session: AsyncSession,
    default_league: League,
    fake_notifications_queue: Queue,
) -> None:
    """Retiring a lapsed result enqueues exactly one "match finalized" notice to
    the owing party (the opponent who never responded) and nothing to the
    proposer — completion already surfaces to the proposer through the normal
    result flow."""
    match, result, poster, opponent = await _build_standing_match(
        db_session, default_league, submitted_ago=timedelta(days=8)
    )

    outcome = await retire_if_lapsed(
        db_session, match.id, result.id, _notifications(db_session)
    )
    assert outcome is RetirementOutcome.retired

    jobs = enqueued_notification_jobs(fake_notifications_queue)
    assert [job.user_id for job in jobs] == [opponent.id]
    assert poster.id not in {job.user_id for job in jobs}
    job = jobs[0]
    assert job.category.value == "result_confirm"
    assert job.link == f"/matches/{match.id}"
    # #1583: the "Match finalized" notice is a closed-loop FYI — the match is
    # already done, so it must never be hideable, and it carries the copy
    # swap ("View result", not "Review") the ticket names.
    assert job.result_id is None
    assert job.action_label == "View result"


# ----- notifications: deadline-nearing reminder ---------------------------


async def _build_reminder_match(
    db_session: AsyncSession, default_league: League, *, deadline_in: timedelta
) -> tuple[Match, MatchResult, User, User]:
    """A standing, still-in-progress match whose derived retirement deadline is
    ``deadline_in`` from now. Deadline = submitted_at + 7-day window, so we
    back-date ``submitted_at`` by ``7 days - deadline_in``."""
    return await _build_standing_match(
        db_session,
        default_league,
        submitted_ago=timedelta(days=7) - deadline_in,
    )


async def test_reminder_within_24h_enqueues_once_and_stamps(
    db_session: AsyncSession,
    default_league: League,
    fake_notifications_queue: Queue,
) -> None:
    """A match whose deadline is inside the next 24h and still in the future,
    with an unset marker, enqueues one reminder to the owing side and stamps
    ``reminder_sent_at``. A second sweep tick re-reads the marker set and does
    NOT re-enqueue."""
    match, result, _poster, opponent = await _build_reminder_match(
        db_session, default_league, deadline_in=timedelta(hours=12)
    )

    reminded = await sweep_due_reminders(db_session, _notifications(db_session))
    assert reminded == 1

    jobs = enqueued_notification_jobs(fake_notifications_queue)
    assert [job.user_id for job in jobs] == [opponent.id]
    assert jobs[0].link == f"/matches/{match.id}"
    # #1583: unlike "Match finalized", the reminder is still asking about a
    # live standing result — it stays hideable, and keeps the "Review" label.
    assert jobs[0].result_id == result.id
    assert jobs[0].action_label == "Review"

    await db_session.refresh(result)
    assert result.reminder_sent_at is not None

    # Second tick: the marker is set, so nothing new is enqueued.
    db_session.expire_all()
    reminded_again = await sweep_due_reminders(db_session, _notifications(db_session))
    assert reminded_again == 0
    assert len(enqueued_notification_jobs(fake_notifications_queue)) == 1


async def test_reminder_beyond_24h_does_not_fire(
    db_session: AsyncSession,
    default_league: League,
    fake_notifications_queue: Queue,
) -> None:
    """A match whose deadline is more than 24h out is not yet due for a reminder:
    nothing is enqueued and the marker stays NULL."""
    _match, result, _poster, _opponent = await _build_reminder_match(
        db_session, default_league, deadline_in=timedelta(days=6)
    )

    reminded = await sweep_due_reminders(db_session, _notifications(db_session))
    assert reminded == 0
    assert enqueued_notification_jobs(fake_notifications_queue) == []

    await db_session.refresh(result)
    assert result.reminder_sent_at is None


async def test_reminder_not_due_when_deadline_already_past(
    db_session: AsyncSession,
    default_league: League,
    fake_notifications_queue: Queue,
) -> None:
    """A match already past its deadline is the *retirement* sweep's job, not the
    reminder's: ``remind_if_due`` treats a non-future deadline as not due."""
    match, _result, _poster, _opponent = await _build_standing_match(
        db_session, default_league, submitted_ago=timedelta(days=8)
    )

    sent = await remind_if_due(db_session, match.id, _notifications(db_session))
    assert sent is False
    assert enqueued_notification_jobs(fake_notifications_queue) == []

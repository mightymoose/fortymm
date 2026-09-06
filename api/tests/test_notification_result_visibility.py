"""Issue #1583: a "Accept your match result" / "A result is waiting for you"
prompt must disappear from the feed and unread count once its bound
``MatchResult`` is no longer live — accepted, superseded (counter or
self-correction), or auto-accepted by the retirement sweep — without the row
being deleted. Match state and ratings are already correct on every one of
these paths; this is a display-only defect.

Drives the real write paths (``propose_result`` / ``accept_result`` /
``retire_if_lapsed``) that flip the underlying ``MatchResult`` state, then
asserts against ``NotificationService.list_feed`` / ``unread_count`` — proving
``app.notifications.service._visible_notifications_clause`` stays in sync with
``app.result_chain.standing_result``, which is the in-memory equivalent the
ticket asks to keep it honest against."""

import uuid
from datetime import UTC, datetime, timedelta

from rq import Queue
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.match_creation import create_match
from app.match_result_notifications import notify_result_accepted, notify_result_posted
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
    Notification,
    User,
)
from app.notifications.service import NotificationService
from app.notifications.taxonomy import NotificationCategory
from app.result_acceptance import accept_result
from app.result_chain import standing_result
from app.result_proposal import propose_result
from app.retirement_jobs import RetirementOutcome, retire_if_lapsed
from app.schemas.match import MatchResultsGameWrite
from app.schemas.notification import NotificationJob
from tests._helpers import FakeSender, enqueued_notification_jobs, make_user

# ----- helpers --------------------------------------------------------------


def _notifications(db: AsyncSession) -> NotificationService:
    return NotificationService(db, FakeSender())


def _decisive_board(winner_side: int) -> list[MatchResultsGameWrite]:
    if winner_side == 1:
        return [MatchResultsGameWrite(game_number=1, side_1_points=11, side_2_points=4)]
    return [MatchResultsGameWrite(game_number=1, side_1_points=4, side_2_points=11)]


async def _standing_singles_match(
    db: AsyncSession, *, creator_name: str, opponent_name: str
) -> tuple[Match, MatchResult, User, User]:
    """A rated singles match with a fresh standing (unaccepted) result posted
    by the creator — the real propose path, mirroring
    ``tests/test_accept_result_service.py``'s ``_propose_standing``."""
    creator = await make_user(db, creator_name)
    opponent = await make_user(db, opponent_name)
    match = await create_match(
        db,
        creator=creator,
        opponent_user_id=opponent.id,
        league_id=None,
        best_of=1,
        rated=True,
    )
    outcome = await propose_result(
        db,
        match.id,
        creator.id,
        games=_decisive_board(1),
        supersedes_result_id=None,
    )
    standing = standing_result(outcome.match)
    assert standing is not None
    return outcome.match, standing, creator, opponent


async def _standing_doubles_match(
    db: AsyncSession, league: League
) -> tuple[Match, MatchResult, list[User], list[User]]:
    """A rated doubles (team_size=2) match with a standing result posted by
    side 1's first player. Built directly against the models (mirrors
    ``tests/test_retirement_jobs.py``'s ``_build_standing_match``) since
    ``create_match``/``propose_result`` don't expose ``team_size``."""
    side1 = [
        await make_user(db, f"dbl-s1-{i}-{uuid.uuid4().hex[:6]}") for i in range(2)
    ]
    side2 = [
        await make_user(db, f"dbl-s2-{i}-{uuid.uuid4().hex[:6]}") for i in range(2)
    ]

    # Unrated: doubles has no rating calculator yet (issue #183) — this test is
    # about notification visibility, not ratings, so sidestep the tripwire.
    settings = MatchSettings(team_size=2, best_of=1, affects_rating=False)
    match = Match(
        match_settings=settings,
        league=league,
        created_by_user_id=side1[0].id,
        status=MatchStatus.in_progress,
    )
    match_side1 = MatchSide(match=match, side_number=1)
    for user in side1:
        match_side1.players.append(
            MatchSidePlayer(match=match, user=user.primary_player)
        )
    match_side2 = MatchSide(match=match, side_number=2)
    for user in side2:
        match_side2.players.append(
            MatchSidePlayer(match=match, user=user.primary_player)
        )
    game = MatchGame(match=match, game_number=1)
    game.score = MatchGameScore(side_1_points=11, side_2_points=4)
    result = MatchResult(
        match=match,
        submitted_for_player_id=side1[0].id,
        submitted_by_user_id=side1[0].id,
        games=[],
    )
    db.add(match)
    await db.commit()
    return match, result, side1, side2


async def _deliver_pending_jobs(
    notifications: NotificationService, queue: Queue
) -> list[NotificationJob]:
    """Hand every job currently sitting on the (fake, async) notifications
    queue to the worker's ``notify`` primitive — mirroring
    ``app.notifications.jobs._deliver`` — so a real ``Notification`` row lands
    in the DB, then clears the queue. The fake queue never runs the job body
    itself (see ``conftest.fake_notifications_queue``), so tests that need the
    persisted row must deliver by hand."""
    jobs = enqueued_notification_jobs(queue)
    for job in jobs:
        await notifications.notify(
            user_id=job.user_id,
            category=job.category,
            title=job.title,
            body=job.body,
            link=job.link,
            action_label=job.action_label,
            delta=job.delta,
            push_category=job.push_category,
            push_data=job.push_data,
            collapse_id=job.collapse_id,
            channels=job.channels,
            result_id=job.result_id,
        )
    queue.empty()
    return jobs


async def _titles(notifications: NotificationService, user_id: uuid.UUID) -> list[str]:
    feed = await notifications.list_feed(user_id)
    return [item.title for item in feed.items]


# ----- resolution paths: accept / counter / self-correction -----------------


async def test_review_prompt_hides_after_accept(
    db_session: AsyncSession, fake_notifications_queue: Queue
) -> None:
    match, standing, creator, opponent = await _standing_singles_match(
        db_session, creator_name="accept-hide-creator", opponent_name="accept-hide-opp"
    )
    notifications = _notifications(db_session)

    await notify_result_posted(notifications, match, creator.id)
    jobs = await _deliver_pending_jobs(notifications, fake_notifications_queue)
    assert len(jobs) == 1
    assert jobs[0].result_id == standing.id
    # #1583's named regression gap: this must be unconditional now, not the
    # old "only when standing_result is not None" conditional add.
    assert jobs[0].push_data is not None
    assert jobs[0].push_data["result_id"] == str(standing.id)

    assert await _titles(notifications, opponent.id) == [jobs[0].title]
    assert (await notifications.unread_count(opponent.id)).unread_count == 1

    await accept_result(db_session, match.id, opponent.id, result_id=standing.id)

    assert await _titles(notifications, opponent.id) == []
    assert (await notifications.unread_count(opponent.id)).unread_count == 0
    # The row survives — hidden, not deleted.
    stored = (
        await db_session.execute(
            select(Notification).where(Notification.user_id == opponent.id)
        )
    ).scalar_one()
    assert stored.result_id == standing.id


async def test_review_prompt_hides_after_counter(
    db_session: AsyncSession, fake_notifications_queue: Queue
) -> None:
    """The opponent counters instead of accepting: their own prompt (bound to
    the now-superseded original) must hide, even though a *new* standing
    result now sits at the head of the chain."""
    match, standing, creator, opponent = await _standing_singles_match(
        db_session,
        creator_name="counter-hide-creator",
        opponent_name="counter-hide-opp",
    )
    notifications = _notifications(db_session)
    await notify_result_posted(notifications, match, creator.id)
    await _deliver_pending_jobs(notifications, fake_notifications_queue)
    assert await _titles(notifications, opponent.id) != []

    await propose_result(
        db_session,
        match.id,
        opponent.id,
        games=_decisive_board(2),
        supersedes_result_id=standing.id,
    )

    assert await _titles(notifications, opponent.id) == []
    assert (await notifications.unread_count(opponent.id)).unread_count == 0


async def test_review_prompt_hides_after_self_correction(
    db_session: AsyncSession, fake_notifications_queue: Queue
) -> None:
    """The poster corrects their own standing proposal before the recipient
    ever answers — a self-edit still supersedes the original result, and the
    recipient's prompt (bound to that original) must hide."""
    match, standing, creator, opponent = await _standing_singles_match(
        db_session,
        creator_name="selfedit-hide-creator",
        opponent_name="selfedit-hide-opp",
    )
    notifications = _notifications(db_session)
    await notify_result_posted(notifications, match, creator.id)
    await _deliver_pending_jobs(notifications, fake_notifications_queue)
    assert await _titles(notifications, opponent.id) != []

    await propose_result(
        db_session,
        match.id,
        creator.id,
        games=_decisive_board(1),
        supersedes_result_id=standing.id,
    )

    assert await _titles(notifications, opponent.id) == []
    assert (await notifications.unread_count(opponent.id)).unread_count == 0


async def test_review_prompt_hides_after_retirement_auto_accept(
    db_session: AsyncSession, fake_notifications_queue: Queue
) -> None:
    match, standing, creator, opponent = await _standing_singles_match(
        db_session,
        creator_name="retire-hide-creator",
        opponent_name="retire-hide-opp",
    )
    notifications = _notifications(db_session)
    await notify_result_posted(notifications, match, creator.id)
    await _deliver_pending_jobs(notifications, fake_notifications_queue)
    assert await _titles(notifications, opponent.id) != []

    # Force the standing result's deadline into the past. Capture the ids
    # before the commit/expire below — the real job reloads by id, not by
    # holding onto these (now-expired) in-memory objects.
    match_id, standing_id, opponent_id = match.id, standing.id, opponent.id
    match.match_settings.retirement_window = timedelta(days=7)
    standing.submitted_at = datetime.now(UTC) - timedelta(days=8)
    await db_session.commit()
    db_session.expire_all()

    outcome = await retire_if_lapsed(db_session, match_id, standing_id, notifications)

    assert outcome is RetirementOutcome.retired

    assert await _titles(notifications, opponent_id) == []
    assert (await notifications.unread_count(opponent_id)).unread_count == 0


# ----- doubles: the whole owing side resolves together -----------------


async def test_doubles_owing_side_resolves_together(
    db_session: AsyncSession, default_league: League, fake_notifications_queue: Queue
) -> None:
    match, standing, side1, side2 = await _standing_doubles_match(
        db_session, default_league
    )
    notifications = _notifications(db_session)

    await notify_result_posted(notifications, match, side1[0].id)
    jobs = await _deliver_pending_jobs(notifications, fake_notifications_queue)
    # One prompt per player on the owing (side 2) side, both bound to the same
    # result_id.
    assert {job.user_id for job in jobs} == {u.id for u in side2}
    assert {job.result_id for job in jobs} == {standing.id}

    for player in side2:
        assert await _titles(notifications, player.id) != []

    await accept_result(db_session, match.id, side2[0].id, result_id=standing.id)

    for player in side2:
        assert await _titles(notifications, player.id) == []
        assert (await notifications.unread_count(player.id)).unread_count == 0


# ----- the async-race case: the row is written after acceptance already ----


async def test_notification_written_after_acceptance_is_hidden_on_first_read(
    db_session: AsyncSession,
) -> None:
    """The RQ worker can write the in-app row after the match was already
    accepted (propose/accept racing ahead of delivery). The read-time
    predicate must exclude it from the very first read — there is no
    write-time flag to have gotten out of sync."""
    match, standing, creator, opponent = await _standing_singles_match(
        db_session, creator_name="race-creator", opponent_name="race-opp"
    )
    result_id = standing.id
    await accept_result(db_session, match.id, opponent.id, result_id=result_id)

    notifications = _notifications(db_session)
    result = await notifications.notify(
        user_id=opponent.id,
        category=NotificationCategory.RESULT_CONFIRM,
        title="Accept your match result",
        body="stale prompt written after the fact",
        result_id=result_id,
    )
    assert result.in_app_created is True

    assert await _titles(notifications, opponent.id) == []
    assert (await notifications.unread_count(opponent.id)).unread_count == 0


# ----- cross-user / cross-match isolation -----------------------------------


async def test_resolving_one_match_never_hides_another_users_prompt(
    db_session: AsyncSession, fake_notifications_queue: Queue
) -> None:
    match_a, standing_a, creator_a, opponent_a = await _standing_singles_match(
        db_session, creator_name="isolation-a-creator", opponent_name="isolation-a-opp"
    )
    match_b, standing_b, creator_b, opponent_b = await _standing_singles_match(
        db_session, creator_name="isolation-b-creator", opponent_name="isolation-b-opp"
    )
    notifications = _notifications(db_session)
    await notify_result_posted(notifications, match_a, creator_a.id)
    await notify_result_posted(notifications, match_b, creator_b.id)
    await _deliver_pending_jobs(notifications, fake_notifications_queue)

    await accept_result(db_session, match_a.id, opponent_a.id, result_id=standing_a.id)

    # Match A's prompt is gone; match B's — a different user, a different
    # result_id — is untouched.
    assert await _titles(notifications, opponent_a.id) == []
    assert await _titles(notifications, opponent_b.id) != []
    assert (await notifications.unread_count(opponent_b.id)).unread_count == 1


# ----- notify_result_posted's own guard: nothing to bind, nothing enqueued --


async def test_notify_result_posted_enqueues_nothing_once_already_accepted(
    db_session: AsyncSession, fake_notifications_queue: Queue
) -> None:
    """#1583's named regression gap: if ``standing_result(match)`` is ``None``
    (e.g. the head was already accepted by the time this runs), there is
    nothing to bind the hideable prompt to — it must not enqueue an unhideable
    prompt with no ``result_id``."""
    match, standing, creator, opponent = await _standing_singles_match(
        db_session,
        creator_name="already-accepted-creator",
        opponent_name="already-accepted-opp",
    )
    await accept_result(db_session, match.id, opponent.id, result_id=standing.id)
    accepted_match = (
        await db_session.execute(select(Match).where(Match.id == match.id))
    ).scalar_one()

    notifications = _notifications(db_session)
    await notify_result_posted(notifications, accepted_match, creator.id)

    assert enqueued_notification_jobs(fake_notifications_queue) == []


# ----- the two FYI notices are never hideable -------------------------------


async def test_result_accepted_notice_stays_visible_regardless(
    db_session: AsyncSession, fake_notifications_queue: Queue
) -> None:
    """``notify_result_accepted``'s "Your result was accepted" notice to the
    poster must never carry a ``result_id`` — it's a closed-loop FYI, not a
    hideable prompt, so it always stays in the feed."""
    match, standing, creator, opponent = await _standing_singles_match(
        db_session,
        creator_name="accepted-notice-creator",
        opponent_name="accepted-notice-opp",
    )
    await accept_result(db_session, match.id, opponent.id, result_id=standing.id)
    accepted_match = (
        await db_session.execute(select(Match).where(Match.id == match.id))
    ).scalar_one()

    notifications = _notifications(db_session)
    await notify_result_accepted(notifications, accepted_match, creator.id)
    jobs = await _deliver_pending_jobs(notifications, fake_notifications_queue)

    assert len(jobs) == 1
    assert jobs[0].result_id is None
    assert jobs[0].action_label == "View result"
    assert await _titles(notifications, creator.id) == [jobs[0].title]
    assert (await notifications.unread_count(creator.id)).unread_count == 1

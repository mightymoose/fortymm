"""Unit tests for ``app.retirement.retirement_deadline``.

``retirement_deadline`` is a pure function over the in-memory object graph, so
these build ``Match`` / ``MatchResult`` / ``MatchSettings`` directly without
touching the database (mirrors ``tests/test_result_acceptance.py``).
"""

import uuid
from datetime import UTC, datetime, timedelta

import pytest

from app.models import Match, MatchResult, MatchSettings, MatchStatus
from app.retirement import retirement_deadline

SUBMITTED_AT = datetime(2026, 7, 1, 12, 0, tzinfo=UTC)
WINDOW = timedelta(days=7)


def _match(
    *,
    window: timedelta | None,
    results: list[MatchResult],
) -> Match:
    match = Match(
        status=MatchStatus.in_progress,
        match_settings=MatchSettings(team_size=1, best_of=5, retirement_window=window),
    )
    for result in results:
        match.results.append(result)
    return match


def _standing_result(*, submitted_at: datetime = SUBMITTED_AT) -> MatchResult:
    return MatchResult(
        id=uuid.uuid4(),
        submitted_by_user_id=uuid.uuid4(),
        games=[],
        submitted_at=submitted_at,
    )


def _accepted_result() -> MatchResult:
    return MatchResult(
        id=uuid.uuid4(),
        submitted_by_user_id=uuid.uuid4(),
        games=[],
        submitted_at=SUBMITTED_AT,
        accepted_by_user_id=uuid.uuid4(),
        accepted_at=SUBMITTED_AT,
    )


def test_standing_result_with_window_returns_submitted_plus_window() -> None:
    match = _match(window=WINDOW, results=[_standing_result()])

    deadline = retirement_deadline(match)

    assert deadline == SUBMITTED_AT + WINDOW
    assert deadline is not None
    assert deadline.tzinfo is not None


def test_accepted_head_has_no_standing_result_returns_none() -> None:
    match = _match(window=WINDOW, results=[_accepted_result()])

    assert retirement_deadline(match) is None


def test_no_results_returns_none() -> None:
    match = _match(window=WINDOW, results=[])

    assert retirement_deadline(match) is None


def test_null_window_returns_none() -> None:
    match = _match(window=None, results=[_standing_result()])

    assert retirement_deadline(match) is None


def test_correction_moves_deadline_to_new_standing_submitted_at() -> None:
    base = _standing_result(submitted_at=SUBMITTED_AT)
    correction_submitted = SUBMITTED_AT + timedelta(days=2)
    correction = MatchResult(
        id=uuid.uuid4(),
        submitted_by_user_id=uuid.uuid4(),
        games=[],
        submitted_at=correction_submitted,
        supersedes_result_id=base.id,
    )
    match = _match(window=WINDOW, results=[base, correction])

    assert retirement_deadline(match) == correction_submitted + WINDOW


@pytest.mark.parametrize(
    ("window", "results", "expected"),
    [
        (WINDOW, [_standing_result()], SUBMITTED_AT + WINDOW),
        (WINDOW, [_accepted_result()], None),
        (WINDOW, [], None),
        (None, [_standing_result()], None),
    ],
)
def test_retirement_deadline_table(
    window: timedelta | None,
    results: list[MatchResult],
    expected: datetime | None,
) -> None:
    assert retirement_deadline(_match(window=window, results=results)) == expected

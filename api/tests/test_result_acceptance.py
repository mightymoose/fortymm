import uuid

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Match, MatchResult, MatchStatus
from app.result_acceptance import (
    StandingResultConflictError,
    accept_standing_result,
)


async def test_accepting_superseded_result_id_signals_conflict(
    db_session: AsyncSession,
) -> None:
    """Accepting a ``result_id`` that a counter has superseded raises the domain
    ``StandingResultConflictError`` (which the router maps to the 409), never an
    ``HTTPException`` — the core must stay usable from a worker with no HTTP
    context. It signals before touching ``db``, so this needs no committed rows.
    """
    submitter = uuid.uuid4()
    base = MatchResult(id=uuid.uuid4(), submitted_by_user_id=submitter, games=[])
    counter = MatchResult(
        id=uuid.uuid4(),
        submitted_by_user_id=submitter,
        games=[],
        supersedes_result_id=base.id,
    )
    match = Match(status=MatchStatus.in_progress)
    match.results.append(base)
    match.results.append(counter)

    # ``counter`` is now the standing head; accepting the superseded ``base.id``
    # is the lost-race case.
    with pytest.raises(StandingResultConflictError):
        await accept_standing_result(
            db_session,
            match,
            result_id=base.id,
            accepted_by_user_id=uuid.uuid4(),
        )

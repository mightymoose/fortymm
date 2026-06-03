"""Serializes the domain ``Match`` into the new ``schemas.view.match_details``
view model. This is the in-progress replacement shape exposed under the ``data``
key on ``MatchDetails`` so the FE can start reading it without breaking the
current contract."""

from __future__ import annotations

from app.domain.match.models import Match as MatchModel
from app.models.match import MatchStatus
from app.schemas.view.match_details import MatchDetails, Scoreboard, Status


def _scoreboard_status(status: MatchStatus) -> Status:
    # Collapses the five-state lifecycle onto the simplified scoreboard
    # tri-state. Exhaustive (no catch-all) so a new MatchStatus member is a
    # type error here until it's mapped. The grouping mirrors the web client's
    # API_TO_TAB in web-client/src/routes/matches/index.tsx — in particular,
    # disputed and voided are both terminal ("final"), not live.
    match status:
        case MatchStatus.pending:
            return Status.SCHEDULED
        case MatchStatus.in_progress:
            return Status.LIVE
        case MatchStatus.completed | MatchStatus.disputed | MatchStatus.voided:
            return Status.FINAL


def serialize_match_details(match: MatchModel) -> MatchDetails:
    return MatchDetails(scoreboard=Scoreboard(status=_scoreboard_status(match.status)))

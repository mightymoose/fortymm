"""Status-label mapping for a match — the single place that turns a match's
lifecycle position into the user-facing label. Lives in the domain layer so
both the matches list and the player-profile routers can derive the same
label without importing each other's internals."""

from app.models.match import Match, MatchStatus


def status_label(match: Match) -> str:
    """User-facing label for a match's lifecycle position. An ``in_progress``
    match with at least one signature has a posted result waiting on the
    other side — surface that distinctly so the FE doesn't need to know
    about ``signatures`` to render it. (Requires ``match.signatures`` to be
    loaded.)"""
    if match.status == MatchStatus.in_progress and match.signatures:
        return "Awaiting confirmation"
    # Exhaustive — adding an enum member is a type error until handled.
    match match.status:
        case MatchStatus.pending:
            return "Scheduled"
        case MatchStatus.in_progress:
            return "Live"
        case MatchStatus.completed:
            return "Final"
        case MatchStatus.disputed:
            return "Disputed"
        case MatchStatus.voided:
            return "Voided"

"""The retirement deadline derived from a match's standing result.

When a match requires confirmation, the posting side's claim sits as a
*standing* (unaccepted) result at the head of the negotiation chain. If the
opponent never accepts, the claim auto-finalizes once the settings'
``retirement_window`` elapses. This leaf module computes *when* that happens.

It depends only on the models and ``app.result_chain`` — never on the router
(``app.matches``) — so both the router and the attention classifier can share
it without an import cycle (mirrors ``app.result_chain``).
"""

from datetime import datetime

from app.models import Match
from app.result_chain import standing_result


def retirement_deadline(match: Match) -> datetime | None:
    """The instant the standing result auto-finalizes, or ``None``.

    Returns ``standing.submitted_at + match.match_settings.retirement_window``
    when there is a standing (unaccepted) result **and** the match's
    ``retirement_window`` is set; otherwise ``None``.

    The gate is the *existence* of a standing result — which exists iff the
    match required confirmation — rather than a re-derived
    ``verification_policy``/``affects_rating`` predicate that could drift from
    it. The result is timezone-aware because ``submitted_at`` comes from a
    ``DateTime(timezone=True)`` column.
    """
    standing = standing_result(match)
    window = match.match_settings.retirement_window
    if standing is None or window is None:
        return None
    return standing.submitted_at + window

"""Navigation over a match's posted-result supersede chain.

The two-verb negotiation model records each proposal as a ``MatchResult`` row
linked to the one it supersedes (``supersedes_result_id``). These pure helpers
walk that chain. They live in their own leaf module — depending only on the
models — so both the router (``app.matches``) and the attention classifier
(``app.attention``) share them without the import cycle that would arise if
they lived on the router (``matches`` imports ``attention``).
"""

from app.models import Match, MatchResult


def head_result(match: Match) -> MatchResult | None:
    """The head of the match's result chain — the one result that nothing
    supersedes — or ``None`` if no result was ever posted.

    The propose endpoint guarantees a linear chain (≤1 head) by minting at most
    one successor per parent, so this walk yields a single row."""
    superseded = {
        r.supersedes_result_id for r in match.results if r.supersedes_result_id
    }
    return next((r for r in match.results if r.id not in superseded), None)


def standing_result(match: Match) -> MatchResult | None:
    """The live, unaccepted proposal at the head of the chain, or ``None``.

    This is the result currently up for acceptance: the head when it has not
    been accepted. Once accepted, the head is the final/agreed result and there
    is no standing proposal."""
    head = head_result(match)
    if head is not None and head.accepted_by_user_id is None:
        return head
    return None


def accepted_result(match: Match) -> MatchResult | None:
    """The accepted (final) result, or ``None`` if none has been accepted.

    A result is accepted ⟺ ``accepted_by_user_id is not None``, which implies
    the match is completed/final."""
    return next((r for r in match.results if r.accepted_by_user_id is not None), None)

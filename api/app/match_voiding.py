"""Voiding a match — the first (and, for now, only) producer of
``MatchStatus.voided``.

``voided`` has existed in the domain and been *read* everywhere (rendered
"Voided", treated as terminal, closed to new proposals, excluded from the
recompute's ``status == completed`` filter) but has never been *written*. This
leaf module gives it its writer.

The domain rule this establishes (see
``docs/adr/0013-a-self-play-collision-transfers-the-match-then-voids-it.md`` and
the "Voided match" glossary entry): **voiding a match deletes its rating
history.** A voided match is *absent* from the rating timeline, not merely
skipped by it. The recompute cannot drop these rows — its ``DELETE`` is scoped
to matches it selected under ``status == completed``, so a voided match's
history is unreachable from there. The void itself must remove them.

Constructible without FastAPI (api/CLAUDE.md service-layer rules): a plain async
function taking the session and the match. It does **not** commit — the caller
(the account-merge self-play-collision path) owns the transaction, matching the
convention in ``account_merge`` / ``result_acceptance``.
"""

from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Match, MatchStatus, RatingHistory


async def void_match(db: AsyncSession, match: Match) -> None:
    """Mark ``match`` voided and delete its ``rating_history`` rows for all
    users.

    Sets ``status = voided`` and removes every ``RatingHistory`` row for this
    match — i.e. both participants' rows. The delete is scoped by ``match_id``,
    never by ``user_id``: by-match is naturally "all users on this match" *and*
    match-local, so a participant's ``initial`` seed row and their history for
    *other* matches survive untouched.

    Deliberately narrow: it does not touch ``completed_at``, ``affects_rating``,
    the sides/players, or anyone's ``UserLeagueRating``. Voiding can strand a
    now-stale current rating (it may have removed a user's only rated match);
    reconciling that is the recompute's job, not this operation's.

    Does not commit — the caller owns the transaction.
    """
    match.status = MatchStatus.voided
    await db.execute(delete(RatingHistory).where(RatingHistory.match_id == match.id))

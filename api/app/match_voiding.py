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

from sqlalchemy import delete, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Match, MatchSide, MatchStatus, RatingHistory


async def void_match(db: AsyncSession, match: Match) -> None:
    """Mark ``match`` voided, clear its sides' decision, and delete its
    ``rating_history`` rows for all users.

    Sets ``status = voided``, nulls ``MatchSide.won`` on **both** sides, and
    removes every ``RatingHistory`` row for this match — i.e. both participants'
    rows. Every delete/update is scoped by ``match_id``, never by ``user_id``:
    by-match is naturally "all users on this match" *and* match-local, so a
    participant's ``initial`` seed row and their history for *other* matches
    survive untouched.

    Clearing ``won`` is what makes "voided ⟹ no winner, no rating history" a
    single indivisible fact. A voided match "contributes nothing" (ADR-0013,
    the "Voided match" glossary entry): any surface that derives a result from
    ``MatchSide.won`` — the player-profile match table does — must see *no
    winner*, not a stale W/L. Status-gated readers (career W-L, form, streak,
    the recompute's ``status == completed`` filter) already drop voided matches;
    nulling ``won`` closes the one reader that isn't gated. The ``UPDATE`` is
    issued via Core rather than ``for side in match.sides`` because the merge
    caller loads the match without eager-loading ``sides``, so an ORM iteration
    would trip an async lazy-load.

    Deliberately narrow otherwise: it does not touch ``completed_at``,
    ``affects_rating``, the sides/players themselves, or anyone's
    ``UserLeagueRating``. The player-less sentinel side and the survivor's side
    (with its player) both stay intact — only their ``won`` flag is cleared.
    Voiding can strand a now-stale current rating (it may have removed a user's
    only rated match); reconciling that is the recompute's job, not this
    operation's.

    Does not commit — the caller owns the transaction.
    """
    match.status = MatchStatus.voided
    await db.execute(
        update(MatchSide).where(MatchSide.match_id == match.id).values(won=None)
    )
    await db.execute(delete(RatingHistory).where(RatingHistory.match_id == match.id))

"""Data access for the tournament read path.

The one thing worth stating up front: an event's registration count is **not a
stored column** (ADR-0016). It is derived from the event's live *active* entries,
which are the same rows the read model lists as its entrants — so the count and
the list are read together, once, and cannot disagree.

The tournament LIST endpoint returns every tournament with all of its events, so
the loader below is batched over **all** the event ids at once: one statement,
regardless of how many events there are. A per-event count would be an N+1, and
``tests/test_tournaments.py`` pins the statement count to keep it that way.
"""

import uuid
from collections.abc import Sequence

from sqlalchemy import and_, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    Tournament,
    TournamentEntry,
    TournamentEntryStatus,
    TournamentEvent,
    User,
    UserLeagueRating,
)
from app.ratings.rated import is_rated_member
from app.schemas.tournament import TournamentEntrantRead


async def active_entrants_by_event(
    db: AsyncSession, event_ids: Sequence[uuid.UUID]
) -> dict[uuid.UUID, list[TournamentEntrantRead]]:
    """The active entrants of every event in ``event_ids``, keyed by event id —
    each carrying their rating **on the tournament's ladder**, or ``None`` where they
    hold none.

    ONE statement for the whole batch (none at all when there are no events).
    Every id gets a key, so an event nobody has entered maps to ``[]`` — the
    caller never has to guess whether a missing key means "no entrants" or "not
    loaded". Withdrawn entries are filtered out here, at the only place that
    reads them, so they can reach neither the entrants list nor the count that is
    derived from it.

    **The rating rides along on that same statement**, and it has to. An unrated player
    passes every rating rule (ADR-0783 §3), which makes a rating cap **opt-out**: a
    sandbagger's optimal move is to never play a rated match and stay eligible for every
    capped event forever. The agreed mitigation is that the director can SEE who took
    that option — so the rating is a fact about *every entrant of every event on the
    page*, not about the caller, and fetching it per entrant would be an N+1 that grows
    with the field it is describing. The statement-count tripwires in
    ``tests/test_tournaments.py`` fail if one appears. Instead the entry's own event
    names its tournament, the tournament names the ladder (``league_id``, ADR-0783
    §2), and the rating LEFT-joins onto that — so the league is read from the rows
    rather than passed in by a caller who could pass the wrong one.

    An entrant who is not rated on that ladder joins to NULL rather than dropping out of
    the list: **belonging to an event and holding a rating in its league are different
    facts**, and the entrant this whole mitigation exists for is precisely the one with
    no rating. That NULL is ``is_rated_member()``'s — NOT ``rating_value IS NULL`` — for
    the reason spelled out on ``entrant_rating`` below: joining a league seeds a 1500
    row, so a brand-new player *has* a ``rating_value``, and keying off the column would
    print a phantom 1500 beside the very sandbagger the director is looking for. The
    entrants list, the ``entry_state`` and the entry route's 409 therefore all read the
    same one definition of Unrated, and cannot come to disagree about who is on the
    ladder.
    """
    entrants: dict[uuid.UUID, list[TournamentEntrantRead]] = {
        event_id: [] for event_id in event_ids
    }
    if not entrants:
        return entrants
    rows = (
        await db.execute(
            select(
                TournamentEntry.id,
                TournamentEntry.event_id,
                TournamentEntry.user_id,
                User.username,
                TournamentEntry.seed,
                UserLeagueRating.rating_value,
            )
            .join(User, User.id == TournamentEntry.user_id)
            # The two hops that answer "rated against WHAT?": the entry's event, and
            # that event's tournament, which is the thing that names the ladder.
            .join(TournamentEvent, TournamentEvent.id == TournamentEntry.event_id)
            .join(Tournament, Tournament.id == TournamentEvent.tournament_id)
            .outerjoin(
                UserLeagueRating,
                and_(
                    UserLeagueRating.user_id == TournamentEntry.user_id,
                    UserLeagueRating.league_id == Tournament.league_id,
                    # In the ON clause, not the WHERE: an unrated entrant must still be
                    # LISTED (with a NULL rating), and a WHERE would delete them from
                    # the entrants list — and from the derived ``entered`` count with it
                    # (ADR-0016), silently freeing a slot in a full event.
                    is_rated_member(),
                ),
            )
            .where(
                TournamentEntry.event_id.in_(entrants.keys()),
                TournamentEntry.status == TournamentEntryStatus.entered,
            )
            # Oldest entry first, matching the event's ``entries`` relationship,
            # so the list is stable across reads.
            .order_by(TournamentEntry.created_at, TournamentEntry.id)
        )
    ).all()
    for entry_id, event_id, user_id, username, seed, rating in rows:
        entrants[event_id].append(
            TournamentEntrantRead(
                id=entry_id,
                user_id=user_id,
                username=username,
                seed=seed,
                rating=rating,
            )
        )
    return entrants


async def active_entry_count(db: AsyncSession, event_id: uuid.UUID) -> int:
    """How many players hold an **active** entry in this event, right now.

    The number ``max_players`` is compared against (ADR-0783). Withdrawn entries are
    not entrants (ADR-0016), so they are filtered out here exactly as they are in
    ``active_entrants_by_event`` — a withdrawal genuinely frees a slot, and a count
    that included the withdrawn rows would seal an event that still has room.

    A fresh ``COUNT(*)`` against the database, not ``len(event.entries)``: this is
    read inside the entry route's tournament row lock, and it must see what the last
    committed writer wrote, not whatever the caller's identity map happens to hold.
    The count is deliberately **not** derived from ``active_entrants_by_event`` —
    loading every entrant to measure the length of the list would make the capacity
    guard's cost grow with the field it is guarding, for a number Postgres will hand
    us in one row.
    """
    return (
        await db.execute(
            select(func.count())
            .select_from(TournamentEntry)
            .where(
                TournamentEntry.event_id == event_id,
                TournamentEntry.status == TournamentEntryStatus.entered,
            )
        )
    ).scalar_one()


async def entrant_rating(
    db: AsyncSession, league_id: uuid.UUID, user_id: uuid.UUID
) -> float | None:
    """A player's rating **on the tournament's ladder** — the number every eligibility
    rule is decided against (ADR-0783) — or ``None`` when they hold none.

    The league is the tournament's own ``league_id``, not a default picked here: an
    eligibility decision that could not say *which* ladder it judged on would not be a
    decision at all.

    **"Unrated" is NOT ``rating_value IS NULL``, and this is the trap.** Joining a
    league SEEDS a rating row at 1500 (the strategy's ``initial_rating_value``) — for
    the default league, that happens when a guest's session is minted, before they have
    played a thing. So a brand-new player *does* have a ``rating_value``, and it is
    1500. Key eligibility off that column alone and the "Under 1500" beginners' event
    refuses every beginner on the platform — a 1500 seed fails ``rating < 1500`` — which
    is the precise harm ADR-0783 §3 exists to prevent, arriving through the back door.
    (ADR-0783 §3 says "``rating_value`` is nullable, so an unrated player has none". The
    *rule* it states is right and is honoured here; the mechanism it names is not how
    this codebase spells "Unrated", and coding to the mechanism would have inverted the
    rule.)

    The one definition of "not Unrated" is ``app.ratings.rated.is_rated_member`` — the
    rating row has been MOVED by something real (a non-``initial`` ``rating_history``
    row: a completed rated match, an admin override, an import), the value is not NULL,
    and the user is not a merged-away tombstone. It is the same predicate the profile,
    the roster, the rank and the percentile are drawn through, so an entrant the
    tournament calls Unrated is exactly the one their profile calls Unrated. Eligibility
    does not get a second opinion about who is on the ladder.

    Everything else is ``None``: no row, a NULL value (a manual league awaiting its
    import), or a seed nothing has moved. All three mean "we hold no rating for this
    player here", they are worth no distinction, and each one passes every rule
    (ADR-0783 §3).

    ONE query, one column: the entry guard runs it inside the tournament's row lock,
    and loading the whole ``UserLeagueRating`` row to read one float off it would drag
    a JSONB ``rating_state`` along for nothing.

    It is the one-league case of ``entrant_ratings_by_league`` rather than a second
    query of its own, so the guard that refuses an entry and the reads that explain it
    cannot come to differ about who is Unrated — the trap above is exactly the kind
    that a second, subtly-different copy of this ``WHERE`` clause would walk into.
    """
    return (await entrant_ratings_by_league(db, [league_id], user_id))[league_id]


async def entrant_ratings_by_league(
    db: AsyncSession, league_ids: Sequence[uuid.UUID], user_id: uuid.UUID
) -> dict[uuid.UUID, float | None]:
    """One player's rating on each of ``league_ids``, keyed by league id — ``None``
    wherever they hold none (which is most players, on most ladders).

    ONE statement for the whole batch (none at all when there are no leagues), and
    every id gets a key, so a caller never has to tell "no rating" apart from "not
    loaded" — the same shape, and the same reasoning, as ``active_entrants_by_event``.

    This is what keeps the tournament reads free of a per-event rating query: a
    tournament's eligibility is judged on ONE ladder (its ``league_id``, ADR-0783), so
    every event of it needs the *same* number, and the list endpoint needs one number
    per distinct league however many tournaments and events it is returning. A
    ``rating`` fetched inside the per-event loop would be an N+1 that grows with the
    field the page is describing; the statement-count tripwires in
    ``tests/test_tournaments.py`` fail if one comes back.

    Who counts as rated is ``is_rated_member`` — see ``entrant_rating`` above for why
    that is emphatically not ``rating_value IS NOT NULL``.
    """
    ratings: dict[uuid.UUID, float | None] = {
        league_id: None for league_id in league_ids
    }
    if not ratings:
        return ratings
    rows = (
        await db.execute(
            select(UserLeagueRating.league_id, UserLeagueRating.rating_value).where(
                UserLeagueRating.league_id.in_(ratings.keys()),
                UserLeagueRating.user_id == user_id,
                is_rated_member(),
            )
        )
    ).all()
    for league_id, rating_value in rows:
        ratings[league_id] = rating_value
    return ratings

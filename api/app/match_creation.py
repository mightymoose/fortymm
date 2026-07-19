"""The transport-neutral core of creating a match.

``create_match`` used to live inline in the ``app.matches`` router handler: it
resolved the opponent, enforced the rated-needs-registered-opponent rule, built
the two sides (including the player-less sentinel side a solo match carries),
committed, and serialised — all in the handler body. It's extracted here as a
leaf module so a second caller (the MCP server, a script, a worker) can drive
the same flow without an HTTP request.

Following ``api/CLAUDE.md``'s rule of thumb, creation is a plain module-level
async function taking ``db`` rather than a class-plus-provider: it has no
collaborator worth injecting (``resolve_league`` is itself a module-level
function). It returns the loaded domain :class:`Match`, ready to serialise, and
signals the three rejection cases with domain exceptions from
``app.match_errors`` — ``SelfMatchError``, ``OpponentNotFoundError``,
``RatedNeedsRegisteredOpponentError`` — never ``HTTPException``. The HTTP
handler is a thin adapter that maps each back to the exact status and body it
produced before.
"""

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.leagues import resolve_league
from app.match_errors import (
    OpponentNotFoundError,
    RatedNeedsRegisteredOpponentError,
    SelfMatchError,
)
from app.match_queries import match_eager_options
from app.models import (
    Match,
    MatchSettings,
    MatchSide,
    MatchSidePlayer,
    MatchStatus,
    User,
)


def _add_side(match: Match, side_number: int, player: User | None) -> None:
    """Attach a side to ``match``. ``player=None`` creates the sentinel
    "no opponent" side — a real second side carrying no player — so an
    opponent-less match still has two sides and is therefore scorable. It reads
    as opponent-less wherever the code inspects ``side.players`` (serialization
    renders the "No opponent" placeholder; rating updates skip player-less
    sides).

    Wiring up the ``match`` relationship on both the side and the side-player
    is what populates their (non-null, denormalized) ``match_id`` columns on
    flush."""
    side = MatchSide(match=match, side_number=side_number)
    if player is not None:
        side.players.append(MatchSidePlayer(match=match, user=player))


async def _load_created_match(db: AsyncSession, match_id: uuid.UUID) -> Match:
    """Reload the just-committed match with the full read eager-load chain.

    Returns a non-optional :class:`Match`: the row was committed one statement
    earlier in the same session, so its absence is a genuine invariant
    violation, not a client-handleable ``None`` — raise loudly rather than hand
    back an ``assert``-guarded value (``api/CLAUDE.md``)."""
    match = (
        await db.execute(
            select(Match).where(Match.id == match_id).options(*match_eager_options())
        )
    ).scalar_one_or_none()
    if match is None:
        raise RuntimeError(f"just-created match {match_id} vanished before reload")
    return match


async def create_match(
    db: AsyncSession,
    *,
    creator: User,
    opponent_user_id: uuid.UUID | None,
    league_id: uuid.UUID | None,
    best_of: int,
    rated: bool,
) -> Match:
    """Create a match for ``creator`` and return it loaded and ready to serialise.

    Resolves the opponent (``opponent_user_id`` optional — a solo match gets a
    player-less sentinel side and is always unrated), enforces the
    rated-needs-registered-opponent rule, builds both sides, commits, and
    reloads. Binds to the default league when ``league_id`` is omitted.

    Raises :class:`SelfMatchError` when the opponent is the creator,
    :class:`OpponentNotFoundError` when the opponent id resolves to no live
    user, and :class:`RatedNeedsRegisteredOpponentError` when a rated match is
    requested with no registered opponent. It never raises ``HTTPException`` —
    it has no HTTP context; the caller adapts these to its transport."""
    opponent: User | None = None
    if opponent_user_id is not None:
        if opponent_user_id == creator.id:
            raise SelfMatchError
        opponent = (
            await db.execute(
                select(User).where(
                    User.id == opponent_user_id,
                    User.merged_into_user_id.is_(None),
                )
            )
        ).scalar_one_or_none()
        if opponent is None:
            raise OpponentNotFoundError

    if rated and opponent is None:
        raise RatedNeedsRegisteredOpponentError

    # Solo matches (no opponent picked) get a player-less sentinel opponent
    # side below, so they're scorable but can never affect ratings regardless
    # of the requested flag.
    affects_rating = rated and opponent is not None

    league = await resolve_league(db, league_id)

    settings = MatchSettings(
        team_size=1,
        best_of=best_of,
        affects_rating=affects_rating,
    )
    match = Match(
        match_settings=settings,
        league=league,
        created_by_user_id=creator.id,
        status=MatchStatus.in_progress,
    )
    _add_side(match, 1, creator)
    # Always create side 2. With no opponent it's a player-less sentinel side,
    # which keeps the match scorable (two sides) while reading as "No opponent".
    _add_side(match, 2, opponent)
    # Games are no longer pre-created at match-create time — they're written
    # lazily by ``POST .../games/{n}/scores/new`` keyed on the game number, so
    # the FE can deep-link to any 1..best_of without us guessing.

    db.add(match)
    await db.commit()

    return await _load_created_match(db, match.id)

"""Checking a signed match result that a player approved.

check_approval() only verifies. It stores nothing, and #188 replaces it with
real recording. It checks no authority either: who may approve for which
player is #188's rule. Anyone who holds the link may send it, so the
signatures are the only authority. The demo match's opponent is a player no
account manages, so an authority check would refuse every demo approval.
"""

from sqlalchemy.orm import Session

from fortymm_api.matches import MatchId
from fortymm_api.services.signing_keys import verification_keys
from fortymm_api.signed_results import (
    Completed,
    GamePoints,
    MatchResult,
    Retired,
    Side,
    VerifiedResult,
    decode_envelope,
)

# A finished game's winner has at least this many points.
GAME_POINTS = 11


class ApprovalRefused(Exception):
    """A refusal that the format can't see, so the codec's Malformed,
    UnknownKey and BadSignature don't cover it. `create_app()` answers 422
    for each."""


class WrongMatch(ApprovalRefused):
    """The result is for another match than the one the request names."""


class IllegalEnding(ApprovalRefused):
    """The games aren't a legal ending to the match: a game's score can't be
    final, the match ends before its last game or isn't decided by it, or a
    retirement comes after the match was decided."""


def check_approval(
    session: Session, match_id: MatchId, envelope: bytes
) -> VerifiedResult:
    """The verified result in `envelope`, for the match `match_id`.

    Raises, in this order: Malformed, WrongMatch, UnknownKey (a kid that
    isn't registered, or was revoked), BadSignature and IllegalEnding. A
    signed-out key still verifies, because results from a hall upload late.
    """
    unverified = decode_envelope(envelope)
    if unverified.match != match_id:
        raise WrongMatch
    verified = unverified.verify(
        key.public_key for key in verification_keys(session, unverified.kids).values()
    )
    check_ending(verified.result)
    return verified


def check_ending(result: MatchResult) -> None:
    """Raise IllegalEnding unless the games are a legal ending to the match.
    web-client/src/scoring/board.ts holds the same rules for the scoring pad.

    A completed match is decided by its last game: every game has a final
    score, and a side reaches the wins it needs at the last game, not before
    and not never. A retired match was not decided: every game but the last
    has a final score, the last may be unfinished, and no side has the wins
    it needs. A retirement before the first point has no games.
    """
    needed = (result.best_of + 1) // 2
    wins = [0, 0]
    match result.ending:
        case Completed():
            for number, points in enumerate(result.games, 1):
                winner = _final_winner(points)
                wins[winner] += 1
                if wins[winner] == needed and number != len(result.games):
                    raise IllegalEnding
            if max(wins) < needed:
                raise IllegalEnding
        case Retired():
            for number, points in enumerate(result.games, 1):
                if number == len(result.games) and _unfinished(points):
                    continue
                wins[_final_winner(points)] += 1
            if max(wins) >= needed:
                raise IllegalEnding


def games_won(result: MatchResult) -> tuple[int, int]:
    """The games each side won, players[0]'s first, in a result that
    check_ending() accepted. A retired match's unfinished last game counts
    for nobody."""
    wins = [0, 0]
    for number, points in enumerate(result.games, 1):
        if (
            isinstance(result.ending, Retired)
            and number == len(result.games)
            and _unfinished(points)
        ):
            continue
        wins[_final_winner(points)] += 1
    return wins[0], wins[1]


def _final_winner(points: GamePoints) -> Side:
    """The side that won a game with this final score: at least 11 points,
    with at most 9 for the loser at 11, or else exactly 2 ahead after
    deuce."""
    a, b = points
    high, low = max(a, b), min(a, b)
    legal = (high == GAME_POINTS and low <= GAME_POINTS - 2) or (
        high > GAME_POINTS and high - low == 2
    )
    if not legal:
        raise IllegalEnding
    return 0 if a > b else 1


def _unfinished(points: GamePoints) -> bool:
    """Whether a game can still go on from this score: nobody has 11 yet,
    or it is at deuce with no 2-point lead."""
    high, low = max(points), min(points)
    return high < GAME_POINTS or (low >= GAME_POINTS - 1 and high - low < 2)

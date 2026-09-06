"""Router-free serialization of a loaded ``Match`` into the ``MatchDetails``
view, plus the pure predicates its ``can_score`` / ``can_finalize`` flags derive
from.

This lives outside ``matches.py`` so that *both* the HTTP handlers and a future
MCP tool module can produce the identical view object without one adapter
importing another router's internals (``api/CLAUDE.md`` — "don't import another
router's internals"; ADR 20260718 "the match flow is a shared service layer
behind HTTP and MCP adapters"). It imports only domain/query/mapper/schema
modules — never a router — so it stays cycle-free.
"""

import uuid
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from sqlalchemy.sql.base import ExecutableOption

from app.domain.match.models import Match as MatchModel
from app.mappers.match_details_mapper import serialize_match_details
from app.mappers.match_extras_mapper import (
    MatchDetailsExtras,
    empty_extras,
    serialize_match_extras,
)
from app.match_queries import (
    current_game_number,
    is_tournament_director,
    match_eager_options,
    my_side,
    singles_user_ids,
)
from app.models import (
    Match,
    MatchGameScore,
    MatchResult,
    MatchSide,
    MatchStatus,
    TournamentEvent,
    TournamentEventStage,
    TournamentFixture,
)

if TYPE_CHECKING:
    from app.services.match_service import MatchService
from app.result_acceptance import (
    _game_winner_side,
    _games_to_win,
    side_win_counts,
)
from app.result_chain import accepted_result, standing_result
from app.retirement import retirement_deadline
from app.schemas.match import (
    MatchDetails,
    MatchDetailsCurrentGame,
    MatchDetailsGame,
    MatchDetailsPlayer,
    MatchDetailsScore,
    MatchDetailsSide,
    MatchLeague,
    MatchNegotiation,
    MatchNotScorableReason,
    MatchResultsGameWrite,
    MatchTournamentContext,
    NegotiationDiffEntry,
    NegotiationGame,
    NegotiationResult,
)
from app.schemas.rating import RatingChange
from app.tournament_queries import ANNOUNCED_STATUSES

# Public shared surface: the serializer/board helpers that both the HTTP router
# (``matches.py``) and the MCP adapter (``mcp_server.py``), plus the scoring /
# proposal / notification services, import. Everything not listed is a
# module-internal helper (leading underscore) and stays private.
__all__ = [
    "compact_games",
    "director_flag_is_material",
    "first_decider",
    "games_payload_from_match",
    "is_participant",
    "is_scorable",
    "load_match_eager",
    "negotiation",
    "resolve_viewer_is_director",
    "score_view",
    "serialize_details",
    "side_schema",
    "status_label",
    "tournament_context",
    "validate_finalize_games",
    "view_extras",
    "view_extras_if_participant",
]


def side_schema(
    side: MatchSide,
    side_wins: dict[int, int],
    current_user_id: uuid.UUID | None,
    rating_changes: Mapping[uuid.UUID, RatingChange] | None = None,
) -> MatchDetailsSide:
    # Singles only for v1: each side has at most one rated player.
    rating_change = (
        rating_changes.get(side.players[0].user_id)
        if rating_changes and side.players
        else None
    )
    return MatchDetailsSide(
        side_number=side.side_number,
        players=[
            MatchDetailsPlayer(
                user_id=p.user_id,
                username=p.user.username,
                is_current_user=p.user_id == current_user_id,
            )
            for p in sorted(side.players, key=lambda p: p.user.username)
        ],
        games_won=side_wins.get(side.side_number, 0),
        won=side.won,
        is_current_user_side=any(p.user_id == current_user_id for p in side.players),
        rating_change=rating_change,
    )


def is_participant(match: Match, user_id: uuid.UUID) -> bool:
    return my_side(match, user_id) is not None


def status_label(match: Match) -> str:
    """User-facing label for a match's lifecycle position. An ``in_progress``
    match with a standing posted result is waiting on the other side — surface
    that distinctly so the FE doesn't need to know about the result model to
    render it."""
    if match.status == MatchStatus.in_progress and standing_result(match) is not None:
        return "Awaiting acceptance"
    # Exhaustive — adding an enum member is a type error until handled.
    match match.status:
        case MatchStatus.pending:
            return "Scheduled"
        case MatchStatus.in_progress:
            return "Live"
        case MatchStatus.completed:
            return "Final"
        case MatchStatus.voided:
            return "Voided"


def score_view(score: MatchGameScore) -> MatchDetailsScore:
    return MatchDetailsScore(
        id=score.id,
        side_1_points=score.side_1_points,
        side_2_points=score.side_2_points,
        winner_side_number=_game_winner_side(score),
        version=score.version,
    )


def _negotiation_game(snapshot: dict[str, int]) -> NegotiationGame:
    return NegotiationGame(
        game_number=snapshot["game_number"],
        side_1_points=snapshot["side_1_points"],
        side_2_points=snapshot["side_2_points"],
    )


def _negotiation_result(result: MatchResult) -> NegotiationResult:
    return NegotiationResult(
        id=result.id,
        games=[
            _negotiation_game(g)
            for g in sorted(result.games, key=lambda g: g["game_number"])
        ],
        submitted_by=(result.submitted_for_player_id or result.submitted_by_user_id),
        submitted_at=result.submitted_at,
    )


def _negotiation_diff(
    baseline_games: list[dict[str, int]],
    standing_games: list[dict[str, int]],
) -> list[NegotiationDiffEntry]:
    """Viewer-relative diff between the viewer's own last proposal (baseline)
    and the standing proposal. Emits one entry per game that differs, ordered by
    game number over the union of both boards. A correction may add, remove, or
    change games (a decided board can shorten or lengthen — CONTEXT.md
    "Correction", ADR-0001), so an entry is one of:

    - **added** — the standing board has a game the baseline lacked (``old=None``);
    - **removed** — the baseline had a game the standing board dropped (``new=None``);
    - **changed** — both present, points differ.

    Unchanged games are skipped. Computed purely from the two snapshots; the
    chain walk to pick the baseline is what collapses the opponent's intermediate
    self-edits."""
    baseline_by_number = {g["game_number"]: g for g in baseline_games}
    standing_by_number = {g["game_number"]: g for g in standing_games}
    entries: list[NegotiationDiffEntry] = []
    for number in sorted(baseline_by_number.keys() | standing_by_number.keys()):
        old = baseline_by_number.get(number)
        new = standing_by_number.get(number)
        if (
            old is not None
            and new is not None
            and old["side_1_points"] == new["side_1_points"]
            and old["side_2_points"] == new["side_2_points"]
        ):
            continue  # unchanged — omit
        # ``old``/``new`` null encode removed/added; both-present is a change.
        entries.append(
            NegotiationDiffEntry(
                game_number=number,
                old=_negotiation_game(old) if old is not None else None,
                new=_negotiation_game(new) if new is not None else None,
            )
        )
    return entries


def _submitted_on_side(match: Match, result: MatchResult, side: MatchSide) -> bool:
    """True iff the result's submitter is a player on ``side``."""
    return any(
        p.user_id == (result.submitted_for_player_id or result.submitted_by_user_id)
        for p in side.players
    )


def negotiation(
    match: Match,
    current_user_id: uuid.UUID | None,
    *,
    viewer_is_director: bool = False,
) -> MatchNegotiation:
    """Viewer-relative negotiation state for the BFF (#713).

    The viewer's "side" is the side the current user is on; the opponent side is
    the other. A standing proposal submitted by the viewer's own side is
    ``awaiting`` (they consented; it's the opponent's move); one submitted by the
    opponent makes it the viewer's turn — ``review`` if the viewer never
    proposed, ``corrected`` (with a diff vs the viewer's own last proposal) if
    they did. ``final`` once a result is accepted; ``live`` before any result.

    Non-participants / anonymous callers get a neutral spectator mapping
    (``your_turn=False``, no diff/prior) — unless ``viewer_is_director``, in
    which case a standing proposal IS the director's to act on and
    ``your_turn`` is True. The director is authorized to accept a player's
    standing proposal (``accept_result``, #1523), and ``can_finalize`` is False
    the moment any result exists, so without this the director has no read flag
    at all that the clients could hang an Accept affordance off — the
    scorers'-table recovery this ticket exists for would stop at the exact
    point a player posts a result. ``viewer_state`` stays ``review``: the
    director never proposed, so there is no baseline to diff against and
    ``corrected`` is unreachable for them.

    ``viewer_is_director`` is resolved by the caller (a query — see
    :func:`resolve_viewer_is_director`) and defaults to False. Every handler
    that returns a whole ``MatchDetails`` passes it: the two read paths (the
    HTTP ``GET /v1/matches/{id}`` handler and the MCP ``get_match`` tool) and
    every write response on both surfaces. The 409 conflict bodies
    (``matches._negotiation_conflict``) and the list rows
    (``matches._list_row``) stay participant-only, matching
    :func:`serialize_details`' own call-site decision — a director who loses an
    accept race re-reads the match rather than re-rendering off the 409."""
    accepted = accepted_result(match)
    if accepted is not None:
        return MatchNegotiation(
            viewer_state="final",
            your_turn=False,
            standing_result=_negotiation_result(accepted),
            prior_result=None,
            diff=None,
            retirement_deadline=retirement_deadline(match),
        )

    standing = standing_result(match)
    if standing is None:
        return MatchNegotiation(
            viewer_state="live",
            your_turn=False,
            standing_result=None,
            prior_result=None,
            diff=None,
            retirement_deadline=retirement_deadline(match),
        )

    standing_view = _negotiation_result(standing)
    viewer_side = (
        my_side(match, current_user_id) if current_user_id is not None else None
    )
    # Spectators / anonymous: neutral mapping — there is a standing proposal but
    # the viewer has no side, so treat as a read-only "review" view. The
    # tournament's director is the one sideless viewer who may act on it.
    if viewer_side is None:
        return MatchNegotiation(
            viewer_state="review",
            # A director never accepts their own proposal. Today that is
            # unreachable — ``_requires_confirmation`` (``app.result_proposal``)
            # self-finalizes every non-participant's proposal, so a standing
            # result's submitter is always a player — but that is a mint-site
            # invariant in another module. This mirrors the identity guard in
            # ``accept_result``: the read flag never offers an Accept the write
            # path would 409, whatever a future mint path does.
            your_turn=(
                viewer_is_director and standing.submitted_by_user_id != current_user_id
            ),
            standing_result=standing_view,
            prior_result=None,
            diff=None,
            retirement_deadline=retirement_deadline(match),
        )

    if _submitted_on_side(match, standing, viewer_side):
        # The viewer's own side proposed the standing result; await the opponent.
        return MatchNegotiation(
            viewer_state="awaiting",
            your_turn=False,
            standing_result=standing_view,
            prior_result=None,
            diff=None,
            retirement_deadline=retirement_deadline(match),
        )

    # The opponent submitted the standing result → the viewer must act. Walk the
    # supersede chain back from the standing result to the viewer's own last
    # proposal (the baseline that collapses the opponent's intermediate edits).
    by_id = {r.id: r for r in match.results}
    prior: MatchResult | None = None
    cursor = standing.supersedes_result_id
    while cursor is not None:
        candidate = by_id.get(cursor)
        if candidate is None:
            break
        if _submitted_on_side(match, candidate, viewer_side):
            prior = candidate
            break
        cursor = candidate.supersedes_result_id

    if prior is None:
        return MatchNegotiation(
            viewer_state="review",
            your_turn=True,
            standing_result=standing_view,
            prior_result=None,
            diff=None,
            retirement_deadline=retirement_deadline(match),
        )

    return MatchNegotiation(
        viewer_state="corrected",
        your_turn=True,
        standing_result=standing_view,
        prior_result=_negotiation_result(prior),
        diff=_negotiation_diff(prior.games, standing.games),
        retirement_deadline=retirement_deadline(match),
    )


def is_scorable(match: Match) -> bool:
    """Whether a match accepts score writes right now (ignoring who's asking).

    The saved games are a provisional *scratchpad* until somebody posts the
    first result: editable regardless of whether they already decide the match.
    So the gates are structural — two sides, a **live** (``in_progress``)
    status, and **no result row at all**. The scratchpad freezes the instant
    the first result is proposed (#715); from there the board only changes via
    the propose/accept negotiation, not the score endpoints.

    ``in_progress`` (not merely non-terminal) is the status gate: a tournament
    match is born ``pending`` (scheduled) and is not scorable until the
    scheduler *calls* it to a table — playing an uncalled match out-of-band
    would corrupt the solver's table model (#1073). This aligns scoring with
    ``can_finalize``, which already required ``in_progress``. Casual matches are
    born ``in_progress`` and so remain scorable at once.

    Single source of truth shared by the write-path guard
    (``ensure_scorable``) and the BFF ``can_score`` flag, so the flag the
    clients trust can never disagree with what the score endpoints accept."""
    return (
        len(match.sides) >= 2
        and match.status == MatchStatus.in_progress
        and not match.results
    )


def director_flag_is_material(match: Match) -> bool:
    """Whether ``viewer_is_director`` can change anything in ``match``'s view —
    the predicate :func:`resolve_viewer_is_director` gates the director query
    on, so no call site pays an extra join for an answer the serializer would
    discard.

    Two disjoint windows, one per affordance the flag drives:

    - **A scorable match** (``is_scorable`` — live, two sides, no result yet):
      the flag feeds ``can_score`` / ``can_finalize``, the scratchpad and the
      "Post result" callout.
    - **A live match carrying a standing proposal**: the flag feeds
      ``negotiation.your_turn``, the Accept affordance. Both ``can_score`` and
      ``can_finalize`` are already False here (each requires no result), and
      there is no standing proposal in the first window, so the two windows
      never overlap — together they are "live, and somebody could still act".

    Every other match (completed, voided, pending) throws the answer away. Those
    are exactly the matches people share links to, so the skip is the hot path.

    One predicate, every call site: the read and write surfaces must widen
    together or two responses about the same match disagree about who may act
    on it."""
    return is_scorable(match) or (
        match.status == MatchStatus.in_progress and standing_result(match) is not None
    )


async def resolve_viewer_is_director(
    db: AsyncSession,
    match: Match,
    current_user_id: uuid.UUID | None,
) -> bool:
    """Resolve the ``viewer_is_director`` input :func:`serialize_details` takes —
    the single answer every ``MatchDetails`` response is built from.

    One function, because a response that reports ``can_score: false`` on a
    write the API just authorized is a contradiction a client acts on: an
    API/MCP caller that treats the mutation response as its next state
    concludes the director's scoring run is over, while a GET on the same
    still-scorable match says the opposite. So the read handlers (HTTP
    ``GET /v1/matches/{id}``, the MCP ``get_match`` tool) and every write
    handler that returns ``MatchDetails`` (the three score verbs, propose and
    accept, on both surfaces) resolve it here rather than each deciding.

    Three short-circuits before the join, in cost order: an anonymous caller
    has no director identity; a participant already holds every flag the
    director bit could add (and is the common case); and
    :func:`director_flag_is_material` throws out the matches where the answer
    changes nothing. Only a signed-in non-participant reading or writing a
    live, unsettled match pays :func:`app.match_queries.is_tournament_director`.

    A write handler could infer the bit for free — ``load_match_for_write``
    turns away everyone who is neither a participant nor the director, so a
    non-participant who got a response *is* one. That inference is deliberately
    not taken: it silently produces a wrong flag the day the write gate widens
    again, and the join it saves only ever runs on the director's own writes.

    ``matches._negotiation_conflict``'s 409 bodies and ``matches._list_row``
    stay participant-only, by decision — a caller who lost a race re-reads the
    match rather than re-rendering off the conflict, and the list rows carry no
    scoring affordance to widen."""
    return (
        current_user_id is not None
        and not is_participant(match, current_user_id)
        and director_flag_is_material(match)
        and await is_tournament_director(db, match.id, current_user_id)
    )


def _scorability_reason(
    match: Match, *, scorable: bool | None = None
) -> MatchNotScorableReason | None:
    """Which of ``is_scorable``'s gates ``match`` fails, or ``None`` when it
    passes all of them. Pure branch selection over the exact same checks
    ``is_scorable`` runs, in the same order — the single source of truth both
    ``ensure_scorable`` (``app/match_scoring.py``, picks its 422/409) and the
    read-side ``MatchDetails.not_scorable_reason`` call, so a write-path
    rejection and the reason a client sees before ever attempting the write
    can never drift apart. A future gate added to ``is_scorable`` without a
    branch of its own here falls through to the catch-all ``not_scorable``,
    exactly like ``ensure_scorable``'s historical catch-all 409.

    ``scorable`` lets a caller that already computed ``is_scorable(match)``
    (``serialize_details`` needs the bool for ``can_score`` regardless) pass
    it straight through instead of running the same pure, in-memory check
    twice."""
    if scorable is None:
        scorable = is_scorable(match)
    if scorable:
        return None
    if len(match.sides) < 2:
        return MatchNotScorableReason.no_opponent
    if match.results:
        return MatchNotScorableReason.result_posted
    if match.status == MatchStatus.pending:
        return MatchNotScorableReason.not_called
    return MatchNotScorableReason.not_scorable


def first_decider(
    games: list[MatchResultsGameWrite], target: int
) -> tuple[int, int] | None:
    """Walk ``games`` in game-number order tallying wins; return
    ``(decided_side, decided_game_number)`` for the first game at which a side
    reaches ``target`` wins, else ``None``.

    Gap-tolerant: it does not care whether the numbers are contiguous — callers
    that require ``1..N`` numbering check that separately. The single source of
    truth for "who clinched, and when" shared by the finalize validator and the
    scratchpad overrun guard, so the two can never drift."""
    wins: dict[int, int] = {1: 0, 2: 0}
    for g in sorted(games, key=lambda g: g.game_number):
        winner = 1 if g.side_1_points > g.side_2_points else 2
        wins[winner] += 1
        if wins[winner] >= target:
            return winner, g.game_number
    return None


def compact_games(
    games: list[MatchResultsGameWrite],
) -> list[MatchResultsGameWrite]:
    """Normalize a (possibly gappy) scratchpad board into a canonical one:
    close empty slots so the surviving scored games are numbered ``1..N`` with
    no holes. Pure — returns fresh models, doesn't mutate input.

    Renumbers by the *rank of each distinct* ``game_number`` (not by list
    position), so a genuine duplicate game_number is preserved as a duplicate
    (two games at original ``1`` both map to new ``1``) and the strict
    ``validate_finalize_games`` duplicate check downstream still rejects it.
    (Renumbering *does* absorb an out-of-``best_of``-range game_number — e.g.
    ``[1,2,5]`` on best-of-3 → ``[1,2,3]`` — but the real scratchpad never
    produces one: the score endpoints reject ``game_number > best_of`` before a
    score is ever saved, and a finalize payload's out-of-range numbers only
    reach here via a hand-crafted API call, where relabeling three legal scored
    games into a legal 3-game board is harmless.)

    Provably outcome-invariant: an empty (unscored) slot contributes 0 wins to
    either side, so dropping it and relabeling can never change the winner or
    the game score — only the cosmetic slot numbers. It heals the out-of-order
    clinch (score game 5 while game 4 is blank → ``[1,2,3,5]`` compacts to
    ``[1,2,3,4]`` and finalizes) without touching a real overrun (a fully-scored
    ``[1,2,3,4,5]`` compacts to itself and stays rejected).
    See ``docs/adr/0002-decided-board-is-compacted-at-propose.md``."""
    rank = {
        original: compacted
        for compacted, original in enumerate(
            sorted({g.game_number for g in games}), start=1
        )
    }
    return [
        MatchResultsGameWrite(
            game_number=rank[g.game_number],
            side_1_points=g.side_1_points,
            side_2_points=g.side_2_points,
        )
        for g in sorted(games, key=lambda g: g.game_number)
    ]


def validate_finalize_games(games: list[MatchResultsGameWrite], best_of: int) -> int:
    """Cross-game invariants for a finalize payload. Per-game point legality
    is already enforced by ``MatchResultsGameWrite``. Returns the decided side
    number (1 or 2); raises ``ValueError`` with a human-readable detail on any
    failure (the route handler maps that to 422)."""
    if not games:
        raise ValueError("A match needs at least one game to finalize.")

    numbers = [g.game_number for g in games]
    if any(n > best_of for n in numbers):
        raise ValueError(f"Each game_number must be ≤ best_of ({best_of}).")
    if len(set(numbers)) != len(numbers):
        raise ValueError("Duplicate game_number in payload.")
    if sorted(numbers) != list(range(1, len(numbers) + 1)):
        raise ValueError("Games must be numbered 1..N consecutively with no gaps.")

    target = _games_to_win(best_of)
    decider = first_decider(games, target)
    if decider is None:
        raise ValueError(
            f"No side reached {target} game wins — the match isn't decided."
        )
    decided_side, decided_at = decider
    if decided_at != max(numbers):
        raise ValueError(
            "Scored games extend past the deciding game; "
            "drop any games after the decider."
        )
    return decided_side


def games_payload_from_match(match: Match) -> list[MatchResultsGameWrite]:
    """Recast currently-saved scores as a finalize payload, so ``_can_finalize``
    can reuse ``validate_finalize_games`` instead of duplicating its rules.

    Returns the board **raw** (scored games at their real ``game_number``, gaps
    and all). The two scratchpad overrun guards depend on this: ``create_game_score``
    reports the tapped game in its 422 detail, and ``update_game_score`` substitutes
    the edited game by matching the raw ``game_number`` — both would break on a
    renumbered board. Compaction is applied by ``_can_finalize`` alone, at its own
    call site, since only the finalize predicate wants a canonical board."""
    return [
        MatchResultsGameWrite(
            game_number=g.game_number,
            side_1_points=g.score.side_1_points,
            side_2_points=g.score.side_2_points,
        )
        for g in match.games
        if g.score is not None
    ]


def _can_finalize(match: Match) -> bool:
    """Whether ``POST /v1/matches/{id}/results`` would succeed on the
    currently-saved scores (ignoring authorization). Drives the FE's
    ``can_finalize`` flag and the submit button's adaptive label.

    Returns False once any result exists — the FE drives this flag only for the
    FIRST proposal; subsequent counters/acceptances flow through the negotiation
    surface, not /results-as-finalize.

    Compacts the saved board before validating, mirroring the write path: a
    gappy-but-decided board (an out-of-order clinch that left a hole) reports
    ``can_finalize = true`` so the finalize-callout / SaveBanner offers "Post
    result" and the user self-heals with one tap — this also heals already-stuck
    matches with no migration."""
    if match.status != MatchStatus.in_progress:
        return False
    if match.results:
        return False
    try:
        validate_finalize_games(
            compact_games(games_payload_from_match(match)),
            match.match_settings.best_of,
        )
    except ValueError:
        return False
    return True


def serialize_details(
    match: Match,
    current_user_id: uuid.UUID | None,
    extras: MatchDetailsExtras | None = None,
    domain_match: MatchModel | None = None,
    *,
    viewer_is_director: bool = False,
    tournament: MatchTournamentContext | None = None,
) -> MatchDetails:
    """Build the viewer-relative ``MatchDetails`` view for ``current_user_id``.

    ``viewer_is_director`` is a second, independent input to ``can_score``,
    ``can_finalize`` and ``negotiation.your_turn`` (#1523 constraint 10: "the
    read flag is a second change, not a consequence of the [write-gate] one") —
    whether ``current_user_id`` created the tournament that materialized
    ``match``, resolved by the caller (a query, so it can't be computed here
    without a session — :func:`resolve_viewer_is_director` is that one
    resolver). Every handler returning a whole ``MatchDetails`` passes it: the
    HTTP detail route, the MCP ``get_match`` tool, and every write response on
    both surfaces, so a response can never deny a write the same request just
    authorized. It defaults to ``False`` for the call sites that don't —
    ``_list_row`` and the 409 conflict bodies (``app.matches``) — by decision;
    see those call sites for why.

    Which of the three flags it can move depends on where the match is in its
    life: the scoring pair before any result exists, ``your_turn`` once a
    player's proposal is standing. :func:`director_flag_is_material` is the
    single predicate the resolver uses to skip the query when neither
    applies."""
    extras = extras or empty_extras()
    # The ``data`` view is built from the domain model. The match-details
    # endpoint loads it through MatchService/MatchRepository and passes it in;
    # the other serialize call sites already hold the full ORM row, so they
    # derive it directly rather than firing a second query.
    domain_match = domain_match or MatchModel.from_row(match)
    side_wins = side_win_counts(match)

    games_sorted = sorted(match.games, key=lambda g: g.game_number)
    games = [
        MatchDetailsGame(
            id=game.id,
            game_number=game.game_number,
            score=score_view(game.score) if game.score else None,
        )
        for game in games_sorted
    ]

    next_number = current_game_number(match)
    current_game = (
        MatchDetailsCurrentGame(game_number=next_number)
        if next_number is not None
        else None
    )

    sides_sorted = sorted(match.sides, key=lambda s: s.side_number)
    # Anonymous viewers on the public route are never participants.
    viewer_is_participant = current_user_id is not None and is_participant(
        match, current_user_id
    )
    # Computed once and reused below for both ``can_score`` and
    # ``not_scorable_reason`` — the same pure, in-memory check, not asked twice.
    scorable = is_scorable(match)

    return MatchDetails(
        id=match.id,
        status=match.status,
        status_label=status_label(match),
        league=MatchLeague(id=match.league.id, name=match.league.name),
        tournament=tournament,
        best_of=match.match_settings.best_of,
        games_to_win=_games_to_win(match.match_settings.best_of),
        team_size=match.match_settings.team_size,
        affects_rating=match.match_settings.affects_rating,
        created_at=match.created_at,
        sides=[
            side_schema(side, side_wins, current_user_id, extras.rating_changes)
            for side in sides_sorted
        ],
        games=games,
        current_game=current_game,
        # "This viewer may edit scores" — true whenever the match is scorable
        # (no result posted yet; see ``is_scorable``), *independent* of whether
        # there's a next un-played game. A decided-but-unposted board is still
        # editable, so this is True while ``current_game`` is None. True for a
        # participant OR the tournament's director (#1523) — matching
        # ``load_match_for_write``'s widened write gate, per constraint 7
        # ("can_score and the write guard must not drift"). Everyone else gets
        # the read-only view — writes 404 in the score endpoints regardless.
        can_score=((viewer_is_participant or viewer_is_director) and scorable),
        not_scorable_reason=_scorability_reason(match, scorable=scorable),
        # True iff the saved games already form a decided, validly-ordered
        # match AND no result is currently posted.
        #
        # Widened to the director alongside ``can_score`` (#1523). It is the
        # ONLY thing that renders the match page's "Post result" callout
        # (``finalize-callout-query.ts``), and a decided board reports
        # ``current_game: None``, which withdraws the Score CTA. Left
        # participant-only, a director arriving at a board the two players
        # scored and walked away from would see neither affordance and have no
        # way to post the result — the exact scorers'-table recovery this
        # ticket exists for. iOS ANDs this with its own participation check
        # (``MatchService.common``), so no director scoring surface appears
        # there.
        can_finalize=(
            (viewer_is_participant or viewer_is_director)
            and len(match.sides) >= 2
            and _can_finalize(match)
        ),
        # Viewer-relative negotiation state — the standing proposal, whose turn
        # it is, and (when the opponent corrected the viewer's own proposal) the
        # diff. Drives the accept CTA + the negotiation callouts (#713).
        # ``viewer_is_director`` reaches it for the same reason it reaches
        # ``can_finalize``: once a player's result stands, ``your_turn`` is the
        # only flag left that can surface the director's authorized accept.
        negotiation=negotiation(
            match, current_user_id, viewer_is_director=viewer_is_director
        ),
        # ``extras.recent_form`` is a read-only Sequence; the response model owns
        # its own list, so copy rather than alias it.
        recent_form=list(extras.recent_form),
        head_to_head=extras.head_to_head,
        data=serialize_match_details(domain_match),
    )


async def load_match_eager(
    db: AsyncSession,
    match_id: uuid.UUID,
    *,
    options: tuple[ExecutableOption, ...] | None = None,
) -> Match | None:
    """Load the eager ``Match`` ORM row the serializer needs (nullable — the
    read path 404s / raises a ``ToolError`` on absence).

    The canonical read-path loader shared by the HTTP ``GET /v1/matches/{id}``
    handler and the MCP ``get_match`` tool so the two can't drift on the
    eager-load chain. ``options`` overrides the default ``match_eager_options()``
    chain (the router's public-details read passes it through)."""
    result = await db.execute(
        select(Match)
        .where(Match.id == match_id)
        .options(*(options if options is not None else match_eager_options()))
    )
    return result.scalar_one_or_none()


async def view_extras(
    match_service: "MatchService", match: Match
) -> MatchDetailsExtras:
    """The participant-only extras block (rating changes, recent form,
    head-to-head) for an already-loaded ``match``.

    The caller hands the service the primitives it already holds and gets back a
    domain model; the SQL lives in ``MatchDetailsRepository`` and the wire shapes
    are built by the extras mapper. Callers gate on participation *before* calling
    this — a non-participant gets ``empty_extras()`` (see #515). Shared by the
    HTTP GET and the MCP ``get_match`` tool so the two produce the identical
    extras assembly."""
    return serialize_match_extras(
        await match_service.load_view_extras(
            match_id=match.id,
            league_id=match.league_id,
            status=match.status,
            as_played=as_played_instant(match),
            user_ids=singles_user_ids(match),
        )
    )


async def view_extras_if_participant(
    match_service: "MatchService", match: Match, current_user_id: uuid.UUID
) -> MatchDetailsExtras:
    """Participant-gated wrapper over :func:`view_extras`, for the score-write
    and negotiation-write response paths (``app.matches``'s score/results
    handlers, the MCP write tools' ``_serialize_written_match``).

    Before #1523 those write handlers could call :func:`view_extras`
    unconditionally: the only way to reach them at all was
    ``load_match_for_write`` finding the caller a participant, so "reached this
    point" already implied "gate on participation before calling this" (see
    :func:`view_extras`'s own docstring). Now that the same write gate also
    authorizes a tournament director who is NOT a participant, that implication
    is gone — an ungated call would hand a director the players' rating/form/
    head-to-head data #515 reserves for participants. This re-checks
    participation and returns ``empty_extras()`` for anyone who fails it,
    mirroring the read path's (``serialize_details`` callers') existing gate."""
    if not is_participant(match, current_user_id):
        return empty_extras()
    return await view_extras(match_service, match)


async def tournament_context(
    db: AsyncSession, match: Match, current_user_id: uuid.UUID | None
) -> MatchTournamentContext | None:
    """The tournament/fixture context for ``match``, or ``None`` when there
    isn't one to show.

    ``None`` covers two different cases: a casual match has no fixture at
    all, and a tournament match whose tournament the caller must not see yet
    (a draft is owner-only, mirroring ``app.tournament_queries.visible_to``'s
    rule, inlined here for an optional/anonymous caller rather than called
    directly — ``visible_to`` takes a non-optional ``user_id`` and pushes into
    a WHERE clause; here we already hold the loaded ``tournament`` row and
    need no second query).

    Reverse-looks-up the fixture the way ``tournament_advancement.py`` does
    (``TournamentFixture.match_id == match.id``) and eager-loads the whole
    ``stage -> event -> tournament`` chain in that one query so the async
    session never lazy-loads across it (``TournamentFixture.stage`` is
    already ``lazy="joined"`` on the model; ``event`` and ``tournament``
    are not, so they're loaded explicitly here). ``Tournament.tables`` then
    loads via its own model-declared ``lazy="selectin"`` — one more query,
    not one per row — so ``table_label`` is a plain in-memory lookup, no
    second explicit query for the ``VenueTable``. Bounded to a fixed few
    queries regardless of caller: there is at most one fixture per match, so
    this never becomes N+1."""
    fixture = (
        await db.execute(
            select(TournamentFixture)
            .where(TournamentFixture.match_id == match.id)
            .options(
                selectinload(TournamentFixture.stage)
                .selectinload(TournamentEventStage.event)
                .selectinload(TournamentEvent.tournament)
            )
        )
    ).scalar_one_or_none()
    if fixture is None:
        return None

    event = fixture.stage.event
    tournament = event.tournament
    is_owner = (
        current_user_id is not None and tournament.owner_account_id == current_user_id
    )
    if tournament.status not in ANNOUNCED_STATUSES and not is_owner:
        return None

    table_label = (
        next(
            (t.label for t in tournament.tables if str(t.id) == fixture.table_id),
            None,
        )
        if fixture.table_id is not None
        else None
    )

    return MatchTournamentContext(
        tournament_id=tournament.id,
        tournament_name=tournament.name,
        tournament_status=tournament.status,
        event_id=event.id,
        event_name=event.name,
        table_label=table_label,
        can_edit=is_owner,
    )


def as_played_instant(match: Match) -> datetime:
    """The match's as-played instant, which the pre-match snapshot anchors its
    strict-``<`` cutoff on (ADR-0012 #951).

    A completed match was *played into* at its ``completed_at`` — the stable axis
    the rest of the rating timeline uses (rating rows are stamped
    ``created_at == completed_at``), so the strict ``<`` cutoff excludes this
    match's own row and its own completed record while including every prior. A
    match not yet decided (pending/live/awaiting) is being walked into *now*, so
    "going into this match" means the players' current standing.

    NOT ``match.created_at``: that is the *creation* instant, which diverges from
    the as-played instant whenever matches are created as a batch (a tournament
    schedule, or a player queuing several) but completed later — a match's
    ``created_at`` then predates its own participants' priors' ``completed_at``,
    filtering every prior out and reporting both players as Unrated · 0."""
    if match.status == MatchStatus.completed and match.completed_at is not None:
        return match.completed_at
    return datetime.now(UTC)

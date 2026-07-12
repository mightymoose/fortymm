"""Whether a player may enter a tournament event, decided in **one** place.

The decision is the server's, and it is computed here — never re-derived by a client
from the raw ``predicates`` JSON (ADR-0783). Two implementations of a rule engine, in
two languages, drift; and the moment they drift, the page offers an Enter button the
API refuses, or hides one it would have honoured. So the entry guard
(``POST …/entries``) and the detail read that explains why the Enter control is not
offered (#783, slice 6) call the *same* function, and there is nothing for them to
disagree about.

Framework-agnostic on purpose: no FastAPI, no SQLAlchemy. It is handed a rating and a
list of stored rules and answers with a value — the router turns a refusal into a 409
(``EntryRefusal.rating_ineligible``), the read path turns the same value into copy.
Loading the rating is somebody else's job (``tournament_queries.entrant_rating``), so
this module can be exercised in a unit test with no database at all, which is why the
operator matrix below is cheap enough to cover every operator at, above and below its
boundary.

**An unrated player passes every rule, and that is not a bug (ADR-0783 §3).**
See ``evaluate_rating_eligibility``. Do not "fix" it.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, assert_never

from pydantic import TypeAdapter

from app.schemas.tournament import Predicate, RatingComparisonOp

# The JSONB column holds plain dicts. Parse them into the same Pydantic model the
# write boundary validated them with — "parse, don't validate" — so the evaluator
# below reads ``rule.op`` off a closed ``Literal`` rather than indexing a
# stringly-keyed dict that a typo could have shaped any way at all.
_PREDICATES: TypeAdapter[list[Predicate]] = TypeAdapter(list[Predicate])


# ----- the rules, as the evaluator sees them --------------------------------


@dataclass(frozen=True)
class RatingBound:
    """One rating compared against one number: ``rating < 1500``."""

    op: RatingComparisonOp
    value: int


@dataclass(frozen=True)
class RatingRange:
    """``between`` — an inclusive ``[min, max]`` window, either end of which may be
    open (``None``): "1200 or over" and "1500 or under" are ranges too."""

    minimum: int | None
    maximum: int | None


@dataclass(frozen=True)
class Unconstrained:
    """A rule with no number in it — the organizer added the row and has not filled
    the value in. It constrains nobody.

    Admitting everyone is the only honest reading: there is nothing to compare a
    rating *to*, so barring the field on it would refuse every player in the world
    on the strength of a half-typed rule."""


RatingRule = RatingBound | RatingRange | Unconstrained


def rating_rule(predicate: Predicate) -> RatingRule:
    """The stored rule, as something the evaluator can decide — total by construction.

    ``Predicate`` is the *wire* shape: ``op`` and ``value`` are independent fields
    there, and only the schema's validator ties them together. This turns that pair
    into a sum type where the tie is structural — a ``RatingBound`` cannot be missing
    its number, a ``RatingRange`` cannot be handed one — so ``_satisfies`` below has
    no "what if the value is the wrong shape?" branch to get wrong.

    Every arm is reachable: a rule the organizer has not finished (``value: null``) is
    a real, storable state, and it is the ``Unconstrained`` one.
    """
    value = predicate.value
    if predicate.op == "between":
        if isinstance(value, list):
            # Padded rather than indexed: ``value[1]`` on a short list is an
            # IndexError, and a total function beats a defended one. The schema
            # already refuses a pair that is not exactly two long, so the padding
            # is a belt to that braces — a missing bound is simply an open one.
            bounds: list[int | None] = [*value, None, None]
            return RatingRange(minimum=bounds[0], maximum=bounds[1])
        return Unconstrained()
    if isinstance(value, int):
        return RatingBound(op=predicate.op, value=value)
    return Unconstrained()


# ----- the decision ---------------------------------------------------------


@dataclass(frozen=True)
class Eligible:
    """The player satisfies every rule the event has (possibly none at all)."""


@dataclass(frozen=True)
class RatingIneligible:
    """The player's rating fails one of the event's rules — the *first* one it fails.

    The rule and the rating both ride along, so a caller can say more than "no": the
    entry route puts them in the refusal's fallback message, and the detail read (6a)
    can name the rule that is in the way. ``predicate_id`` addresses the stored rule,
    so a page that renders the rules as chips can point at the one that refused.
    """

    predicate_id: str
    rule: RatingBound | RatingRange
    rating: float

    @property
    def message(self) -> str:
        """The refusal in words — a *fallback*, not the contract (ADR-0968).

        The client switches on the ``rating_ineligible`` code and owns its own copy;
        this is what is shown by a client that does not know the code, and what a
        human reads in a log. Both facts are in it, because "you are not eligible"
        with neither the rating nor the rule tells the player nothing they can act on.
        """
        return (
            f"Your rating on this tournament's ladder is {_format_rating(self.rating)},"
            f" and this event is for {describe_rule(self.rule)}."
        )


Eligibility = Eligible | RatingIneligible


def evaluate_rating_eligibility(
    *, rating: float | None, predicates: Sequence[dict[str, Any]]
) -> Eligibility:
    """Decide a player's eligibility for one event: their ``rating`` on the
    tournament's ladder against the event's stored ``predicates``.

    Rules are **ANDed** — a player must satisfy every one — so the first failure ends
    it, and an event with no rules admits everybody.

    **AN UNRATED PLAYER PASSES EVERY RULE. THIS IS DELIBERATE — DO NOT "FIX" IT.**

    ``rating`` is ``None`` when the player holds no rating on the tournament's league:
    they have never finished a rated match there (CONTEXT.md, "Unrated entrant"). That
    is **not** the same as a NULL ``rating_value`` — joining a league seeds a 1500 row
    before a player has played anything — so who counts as unrated is decided by
    ``tournament_queries.entrant_rating`` through ``app.ratings.rated.is_rated_member``,
    the same predicate the profile and the roster use. Read its docstring before
    changing how a rating reaches this function; a seeded 1500 arriving here as a
    *rating* silently refuses every beginner from the beginners' event. A rule of
    ``rating < 1500`` **admits** an unrated player, and so does ``rating > 1800`` —
    every operator, no exceptions, both directions. The reason (ADR-0783 §3): the
    alternative, where unrated fails every rule, locks a brand-new player out of the
    *Under 1500 beginners' event*, which is precisely the event that exists for them,
    and a genuinely new player is genuinely weak — that is the common case, not the
    edge one.

    The cost is known and accepted, not overlooked: it makes a rating **cap** opt-out
    — a sandbagger can stay unrated forever and remain eligible for every capped
    event. It is mitigated where it can be acted on, by marking unrated entrants in
    the entrants list so the director (who may withdraw them) can see who took the
    opt-out. It is *not* mitigated by guessing a rating we do not have, which is what
    refusing them would amount to.

    So: the ``None`` check is first, before a single rule is read. If you are here
    because a lower-bound rule "obviously" should refuse an unrated player, read
    ADR-0783 §3 — and ``test_an_unrated_player_passes_every_operator``, which exists
    to make this decision expensive to reverse by accident.
    """
    if rating is None:
        return Eligible()
    for predicate in _PREDICATES.validate_python(list(predicates)):
        rule = rating_rule(predicate)
        if isinstance(rule, Unconstrained):
            continue
        if not _satisfies(rule, rating):
            return RatingIneligible(predicate_id=predicate.id, rule=rule, rating=rating)
    return Eligible()


def _satisfies(rule: RatingBound | RatingRange, rating: float) -> bool:
    match rule:
        case RatingBound():
            return _compare(rule.op, rating, rule.value)
        case RatingRange():
            # Inclusive at both ends, and an open bound is no bound: ``[None, 1500]``
            # is "1500 or under", not "between nothing and 1500".
            return (rule.minimum is None or rating >= rule.minimum) and (
                rule.maximum is None or rating <= rule.maximum
            )


def _compare(op: RatingComparisonOp, rating: float, value: int) -> bool:
    """The six comparisons, spelled out.

    An exhaustive ``match`` over the ``Literal``, with ``assert_never`` at the end: a
    seventh comparison added to ``RatingComparisonOp`` is a **type error here** until
    somebody says what it means. A dict of ``operator.lt``-style callables would
    answer a new operator with a ``KeyError`` at runtime instead — on a player's entry
    request.

    The strict/non-strict pairs are the whole point of writing them out: ``<`` refuses
    a player rated *exactly* at the cap and ``<=`` admits them, and that off-by-one is
    invisible until a test puts a player on the boundary (there is one per operator).
    """
    match op:
        case "<":
            return rating < value
        case "<=":
            return rating <= value
        case ">":
            return rating > value
        case ">=":
            return rating >= value
        case "=":
            return rating == value
        case "!=":
            return rating != value
        case _:
            assert_never(op)


# ----- capacity --------------------------------------------------------------


def event_is_full(*, entered: int, max_players: int | None) -> bool:
    """Whether an event has no room left — the *other* half of "may I enter?", and the
    only one that is not about the player at all.

    It lives beside the rating evaluator, and not in the two places that ask it,
    because the entry guard (``_enforce_event_has_room``) and the detail read that
    explains why the Enter control is missing must never disagree about what "full"
    means — the same reason the rating decision is a single function (ADR-0783).

    **AN UNCAPPED EVENT IS NEVER FULL (ADR-0935).** ``max_players`` is nullable and
    ``None`` is the "no cap" sentinel — not a cap of zero, and not a missing number to
    be defaulted. So the ``None`` check is first, before ``entered`` is looked at, and
    the answer is always ``False``: there is no limit for a count to reach, so no field
    is large enough to close the event. Reading ``None`` as "full" would be the worst
    available failure — the uncapped event, the one that admits everybody, would be the
    one nobody could enter — and reading it as ``0`` (via a ``max_players or 0``) is the
    same bug spelled arithmetically. Total over the sentinel here, once, so that no
    caller has to defend against it and no caller can get it wrong.

    ``>=``, not ``==``, when there IS a cap: an event whose ``max_players`` was lowered
    under a field that has already filled past it IS full. ``==`` would sail straight
    past it and keep admitting players, and a capacity check must never fail in the
    permissive direction.

    ``entered`` is a count of **active** entries (ADR-0016) — withdrawn entries are
    not entrants and their slots are genuinely free. Where that count comes from is
    the caller's business: the guard takes a fresh ``COUNT(*)`` under the tournament's
    row lock (nothing else is safe against two entrants racing for the last slot), the
    read path takes the length of the entrants list it has already loaded (which is
    the same number, and costs no second query).
    """
    if max_players is None:
        return False
    return entered >= max_players


# ----- words -----------------------------------------------------------------


def describe_rule(rule: RatingBound | RatingRange) -> str:
    """A rule as a phrase about the players it admits — "players rated under 1500".

    Deliberately about the *event*, not about the operator: a player refused entry is
    not helped by being shown ``rating < 1500``, they are helped by being told what
    the event is for. Shared with the read path (6a) so the refusal and the
    explanation are the same sentence.
    """
    match rule:
        case RatingBound():
            return _describe_bound(rule.op, rule.value)
        case RatingRange():
            return _describe_range(rule.minimum, rule.maximum)


def _describe_bound(op: RatingComparisonOp, value: int) -> str:
    match op:
        case "<":
            return f"players rated under {value}"
        case "<=":
            return f"players rated {value} or under"
        case ">":
            return f"players rated over {value}"
        case ">=":
            return f"players rated {value} or over"
        case "=":
            return f"players rated exactly {value}"
        case "!=":
            return f"players not rated {value}"
        case _:
            assert_never(op)


def _describe_range(minimum: int | None, maximum: int | None) -> str:
    if minimum is not None and maximum is not None:
        return f"players rated between {minimum} and {maximum}"
    if minimum is not None:
        return f"players rated {minimum} or over"
    if maximum is not None:
        return f"players rated {maximum} or under"
    # Both bounds open. Nobody is ever refused by it — it admits the whole world — so
    # this phrase cannot reach a refusal message; it exists because the function is
    # total, and because 6a renders rules that have refused nobody.
    return "players of any rating"


def _format_rating(rating: float) -> str:
    """1650.0 → "1650"; 1512.5 → "1512.5". A rating is stored as a float, and "1650.0"
    in a sentence reads like a machine talking."""
    return f"{rating:g}"

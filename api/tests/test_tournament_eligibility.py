"""The eligibility evaluator (ADR-0783), exercised with no database in sight.

It is a pure function of a rating and a list of stored rules, which is what makes the
matrix below affordable: **every operator at, above and below its boundary**. Those
at-the-boundary rows are the ones with teeth — ``<`` and ``<=`` agree about every
rating except the one *exactly at* the cap, so a suite that only tested 1400 and 1650
against ``< 1500`` would pass just as happily against the wrong operator.

The other load-bearing file here is ``test_an_unrated_player_passes_every_operator``.
An unrated player passing a rule of ``rating < 1500`` looks like a bug and is not
(ADR-0783 §3): the alternative bars a brand-new player from the beginners' event that
exists for them. It is pinned per-operator, in both directions, so reversing it by
"fixing" the evaluator is a red suite rather than a quiet product harm.
"""

from typing import Any

import pytest

from app.schemas.tournament import Predicate
from app.tournament_eligibility import (
    Eligible,
    RatingBound,
    RatingIneligible,
    RatingRange,
    Unconstrained,
    describe_rule,
    evaluate_rating_eligibility,
    rating_rule,
)

# Every operator the schema allows — the list the "unrated passes them all" and
# "an unfilled rule constrains nobody" tests sweep. If a new operator is added to
# ``PredicateOp`` and not to here, those two tests stop covering it.
OPS: list[str] = ["<", "<=", ">", ">=", "=", "!=", "between"]

CAP = 1500


def _rule(op: str, value: object, id: str = "pr-1") -> dict[str, Any]:
    return {"id": id, "field": "rating", "op": op, "value": value}


def _fails(op: str) -> dict[str, Any]:
    """A rule that a *rated* player would fail, for each operator — so a test that
    sees an ``Eligible`` cannot be seeing a rule that admits everyone anyway."""
    return _rule(op, [1, 2] if op == "between" else CAP)


# ----- the operator matrix ---------------------------------------------------


@pytest.mark.parametrize(
    ("op", "below", "at", "above"),
    [
        # rating 1400 (below the 1500 cap) | rating 1500 (AT it) | rating 1600 (above)
        ("<", True, False, False),
        ("<=", True, True, False),
        (">", False, False, True),
        (">=", False, True, True),
        ("=", False, True, False),
        ("!=", True, False, True),
    ],
)
def test_each_comparison_operator_at_above_and_below_its_boundary(
    op: str, below: bool, at: bool, above: bool
) -> None:
    """``<`` refuses the player rated exactly at the cap; ``<=`` admits them — and the
    mirror of that for ``>``/``>=``. The middle column is the whole test."""
    for rating, admitted in ((1400.0, below), (1500.0, at), (1600.0, above)):
        decision = evaluate_rating_eligibility(
            rating=rating, predicates=[_rule(op, CAP)]
        )
        assert isinstance(decision, Eligible) is admitted, (
            f"rating {rating} against `rating {op} {CAP}`"
        )


@pytest.mark.parametrize(
    ("rating", "admitted"),
    [
        (1199.0, False),  # below the window
        (1200.0, True),  # AT the lower bound — inclusive
        (1350.0, True),  # inside
        (1500.0, True),  # AT the upper bound — inclusive
        (1501.0, False),  # above the window
    ],
)
def test_between_is_inclusive_at_both_bounds(rating: float, admitted: bool) -> None:
    decision = evaluate_rating_eligibility(
        rating=rating, predicates=[_rule("between", [1200, 1500])]
    )
    assert isinstance(decision, Eligible) is admitted


@pytest.mark.parametrize(
    ("bounds", "rating", "admitted"),
    [
        ([None, 1500], 1500.0, True),  # "1500 or under" — the open end bars nobody
        ([None, 1500], 1501.0, False),
        ([1200, None], 1200.0, True),  # "1200 or over"
        ([1200, None], 1199.0, False),
        ([None, None], 4000.0, True),  # both ends open — a window round the world
    ],
)
def test_an_open_bound_on_between_is_no_bound(
    bounds: list[int | None], rating: float, admitted: bool
) -> None:
    decision = evaluate_rating_eligibility(
        rating=rating, predicates=[_rule("between", bounds)]
    )
    assert isinstance(decision, Eligible) is admitted


# ----- the counterintuitive rule (ADR-0783 §3) -------------------------------


@pytest.mark.parametrize("op", OPS)
def test_an_unrated_player_passes_every_operator(op: str) -> None:
    """**An unrated player passes EVERY rating rule.** Every operator, both
    directions, no exceptions (ADR-0783 §3).

    If you are reading this because you "fixed" the evaluator to refuse an unrated
    player — most likely on a *lower-bound* rule like ``rating > 1800``, where refusing
    them feels obviously right — that is the change this test exists to stop. The rule
    is not "unrated is treated as 0" and it is not "unrated fails what it cannot
    satisfy": it is that a rule has **no honest answer** about a player we hold no
    rating for, and the product answers "yes", because the alternative locks a
    brand-new player out of the *Under 1500 beginners' event*, which is the single
    most likely event for them to be trying to enter.

    The cost — a rating cap is opt-out, because a sandbagger can stay unrated forever
    — is stated in the ADR, accepted, and mitigated by *marking* unrated entrants for
    the director, not by guessing a rating we do not have.
    """
    assert isinstance(
        evaluate_rating_eligibility(rating=None, predicates=[_fails(op)]), Eligible
    )


def test_an_unrated_player_passes_a_lower_bound_rule_too() -> None:
    """The case that most invites the "fix": an *elite* event (``rating > 1800``) does
    not bar the unrated player either. Same rule, and the same reason — a rating we do
    not hold cannot refuse anybody."""
    assert isinstance(
        evaluate_rating_eligibility(rating=None, predicates=[_rule(">", 1800)]),
        Eligible,
    )


def test_an_unrated_player_passes_every_rule_of_a_multi_rule_event() -> None:
    assert isinstance(
        evaluate_rating_eligibility(
            rating=None,
            predicates=[_rule(">=", 1200, "a"), _rule("<", 1500, "b")],
        ),
        Eligible,
    )


# ----- ANDing, empty rules, unfilled rules -----------------------------------


def test_an_event_with_no_rules_admits_everybody() -> None:
    assert isinstance(
        evaluate_rating_eligibility(rating=2400.0, predicates=[]), Eligible
    )


def test_rules_are_anded_and_the_first_failure_is_the_one_reported() -> None:
    """Every rule must be satisfied. The player clears the floor and fails the cap, so
    the refusal names the *cap* — the rule that actually refused them, addressed by its
    stored id, which is what lets a page point at the chip in the way."""
    decision = evaluate_rating_eligibility(
        rating=1650.0,
        predicates=[_rule(">=", 1200, "floor"), _rule("<", 1500, "cap")],
    )

    assert isinstance(decision, RatingIneligible)
    assert decision.predicate_id == "cap"
    assert decision.rule == RatingBound(op="<", value=1500)
    assert decision.rating == 1650.0


def test_satisfying_every_rule_of_a_multi_rule_event_is_eligible() -> None:
    assert isinstance(
        evaluate_rating_eligibility(
            rating=1350.0,
            predicates=[_rule(">=", 1200, "floor"), _rule("<", 1500, "cap")],
        ),
        Eligible,
    )


@pytest.mark.parametrize("op", OPS)
def test_a_rule_with_no_value_yet_constrains_nobody(op: str) -> None:
    """A half-written rule (the organizer added the row, typed no number) is storable
    — an event may be saved mid-edit — and it admits everyone.

    The other reading, where an unfilled rule refuses the whole field, would take an
    event whose director was interrupted and quietly close it to every player alive.
    """
    assert isinstance(
        evaluate_rating_eligibility(rating=1650.0, predicates=[_rule(op, None)]),
        Eligible,
    )


def test_a_fractional_rating_is_compared_as_a_number_not_rounded() -> None:
    """Ratings are floats (Glicko-2 does not deal in integers); rule values are whole
    numbers. 1499.6 is under a 1500 cap, and a rounding step would wrongly refuse it."""
    assert isinstance(
        evaluate_rating_eligibility(rating=1499.6, predicates=[_rule("<", CAP)]),
        Eligible,
    )


# ----- the rules, as the evaluator sees them ---------------------------------


def test_rating_rule_reads_a_between_pair_as_a_range() -> None:
    predicate = Predicate.model_validate(_rule("between", [1200, 1500]))
    assert rating_rule(predicate) == RatingRange(minimum=1200, maximum=1500)


def test_rating_rule_reads_an_unfilled_rule_as_unconstrained() -> None:
    assert rating_rule(Predicate.model_validate(_rule("<", None))) == Unconstrained()
    assert (
        rating_rule(Predicate.model_validate(_rule("between", None))) == Unconstrained()
    )


# ----- words -----------------------------------------------------------------


@pytest.mark.parametrize(
    ("rule", "phrase"),
    [
        (RatingBound(op="<", value=1500), "players rated under 1500"),
        (RatingBound(op="<=", value=1500), "players rated 1500 or under"),
        (RatingBound(op=">", value=1800), "players rated over 1800"),
        (RatingBound(op=">=", value=1800), "players rated 1800 or over"),
        (RatingBound(op="=", value=1500), "players rated exactly 1500"),
        (RatingBound(op="!=", value=1500), "players not rated 1500"),
        (
            RatingRange(minimum=1200, maximum=1500),
            "players rated between 1200 and 1500",
        ),
        (RatingRange(minimum=1200, maximum=None), "players rated 1200 or over"),
        (RatingRange(minimum=None, maximum=1500), "players rated 1500 or under"),
        (RatingRange(minimum=None, maximum=None), "players of any rating"),
    ],
)
def test_a_rule_describes_the_players_it_admits(
    rule: RatingBound | RatingRange, phrase: str
) -> None:
    """The phrase is about the *event*, not the operator: a refused player is not
    helped by ``rating < 1500``, they are helped by "this event is for players rated
    under 1500"."""
    assert describe_rule(rule) == phrase


def test_the_refusal_message_carries_the_rating_and_the_rule() -> None:
    """Both facts, or the fallback message tells the player nothing they can act on.
    And the rating reads as a number a human wrote — ``1650``, not ``1650.0``."""
    decision = evaluate_rating_eligibility(rating=1650.0, predicates=[_rule("<", CAP)])

    assert isinstance(decision, RatingIneligible)
    assert decision.message == (
        "Your rating on this tournament's ladder is 1650, "
        "and this event is for players rated under 1500."
    )

from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING, Literal

from pydantic import BaseModel, computed_field

from app.domain.rating import rating_delta
from app.ratings.confidence import ConfidenceLevel, confidence_level
from app.ratings.rated import reported_rating_before

if TYPE_CHECKING:
    from app.models.rating_history import RatingHistory


# The calendar windows the rating chart offers (ADR-0915). A closed domain, so a
# `Literal` rather than a `str` + validator: the range is checked statically,
# self-documents in OpenAPI, and `window_start` can `match` on it exhaustively.
RatingWindow = Literal["30d", "90d", "1y"]

# The window the profile loads with when the caller names none.
DEFAULT_RATING_WINDOW: RatingWindow = "90d"


class RatingChange(BaseModel):
    """What one completed match did to a player's rating — and there are two kinds
    of that, not one.

    A player who was already rated MOVED: ``1338 → 1503``, ``delta`` ``+165``.

    A player whose FIRST rated match this is was **ESTABLISHED** by it: they were
    Unrated going in (CONTEXT.md, "Rating": a player who has never finished a rated
    match has no rating), and they came out at 1268. They did not *lose* 232 points
    of the 1500 their league-join seeded them with — they never held it. So
    ``before`` is ``None`` and there is NO delta: nothing moved, a rating came into
    existence. `Unrated → 1268`.

    The seeded 1500 is real in the WRITE side and stays there: the Glicko-2 update
    genuinely starts from the strategy's initial state, and ``previous_rating_value``
    records it faithfully. This model is where the read side declines to narrate
    that prior as a rating the player fell from — the same refusal
    ``app.ratings.rated`` makes for rating / rank / peak / confidence. The caller
    supplies the one fact the row cannot know on its own (``had_rating_before``, an
    earlier change exists), because "was I rated?" is a question about the player's
    history, not about this row.

    ``delta`` is COMPUTED, never stored beside its own inputs (api/CLAUDE.md): a
    ``RatingChange(before=None, delta=-232.0)`` — precisely the phantom of #952 — is
    not constructible.
    """

    # ``None`` == UNRATED going in. Not "unknown", and not zero: the player held no
    # rating at that instant, and this match is what gave them one. Required (no
    # default) so the key is always PRESENT on the wire and a client reads the null
    # rather than an absent field.
    before: float | None
    after: float

    @computed_field  # type: ignore[prop-decorator]  # pydantic: decorate the property, not its getter
    @property
    def delta(self) -> float | None:
        """How far the rating MOVED, or ``None`` when it was established rather than
        moved.

        Two distinct nulls reach a client and they mean different things: a null
        *``RatingChange``* is "this match moved no rating at all" (unrated, undecided
        or voided); a null ``delta`` INSIDE a present change is "this is the rating
        you got, and there was nothing before it to measure from". A ``0.0`` here
        would claim a rated match moved a rating by nothing.

        The arithmetic itself is ``app.domain.rating.rating_delta`` — never inlined
        here — so this wire model and the match-details domain
        (``app.domain.match.extras.RatingChange.delta``) cannot drift into
        disagreeing about the same player's movement.
        """
        return rating_delta(self.before, self.after)

    @classmethod
    def from_history(
        cls, row: RatingHistory, *, had_rating_before: bool
    ) -> RatingChange:
        """Project an audit row into the change it should be REPORTED as.

        ``had_rating_before`` is ``app.ratings.rated.had_rating_before()`` read
        alongside the row (an earlier non-``initial`` change for this user + league).
        It is keyword-only and has no default deliberately: every caller must answer
        it, because defaulting it either way silently mis-narrates one of the two
        cases — and the wrong default is exactly the bug (#952).

        The raw column is not touched here: ``reported_rating_before`` is its one
        reader in ``app/``, shared with the match-details path
        (``MatchDetailsRepository.rating_changes``), so the two surfaces resolve the
        seeded 1500 prior identically.
        """
        return cls(
            before=reported_rating_before(row, had_rating_before=had_rating_before),
            after=row.rating_value,
        )


class RatingInterval(BaseModel):
    """The 95% interval around a rating — "we think this player is somewhere
    between 1551 and 1823". Whole rating points, low first."""

    low: float
    high: float


class RatingConfidence(BaseModel):
    """How settled a player's rating is on one ladder (CONTEXT.md, "Rating
    confidence").

    `interval` is the rigorous statement and belongs on the card's face;
    `deviation` (Glicko-2 RD) and `volatility` (sigma) are the internals BEHIND
    confidence, not names for it — the client keeps them in a drawer.

    There is deliberately NO confidence PERCENTAGE. That number does not exist:
    it would be an arbitrary rescaling of RD onto a 0-100 axis, saying nothing
    the level and the interval don't say better. Do not add one.
    """

    # The Glicko-2 rating deviation: how far off the rating could be.
    deviation: float
    # The Glicko-2 volatility (sigma): how erratic this player's results are.
    # Display-only — nothing about the level or the interval is derived from it.
    volatility: float
    # `rating ± 1.96 × deviation`. Stored rather than computed because it needs
    # the RATING, which is not on this model (it is the hero's `rating`) — unlike
    # `level`, which is a pure function of `deviation` alone and so must not be
    # stored beside it (api/CLAUDE.md: no field plus its own derivation).
    interval: RatingInterval

    @computed_field  # type: ignore[prop-decorator]  # pydantic: decorate the property, not its getter
    @property
    def level(self) -> ConfidenceLevel:
        """provisional / firming_up / settled, keyed off `deviation` alone.

        Derived, never stored: a `RatingConfidence(level="settled",
        deviation=350.0)` — a rating that claims to be settled while the system
        has no idea where the player belongs — is not constructible. The cut
        points live in one place, `app.ratings.confidence`.
        """
        return confidence_level(self.deviation)


class RatingPoint(BaseModel):
    """One instant on a player's **rating timeline** (CONTEXT.md): what their
    rating became, and when it became that.

    `at` is the *completion* instant of the match that moved it (ADR-0012) — not
    when the audit row happened to be written, which a recompute rewrites. For a
    manual / import / initial change there is no match, so `at` is the moment the
    change was recorded and `match_id` is `null`.
    """

    at: datetime
    rating: float
    # The match that moved the rating there. ``None`` for a rating supplied
    # outside of play (a manual override, an import, a seeded initial value) —
    # those are real points on the timeline and the chart draws them too.
    match_id: uuid.UUID | None = None


class RatingHistoryWindow(BaseModel):
    """A player's rating over one CALENDAR window — the profile's rating chart
    (ADR-0915).

    The chart plots rating against *calendar time*, not against the player's
    match sequence, and the `rating_history` audit cannot pay for that on its own:
    it holds rows only where matches completed, so the window's left edge is
    almost never a match. Hence `anchor`.
    """

    # The player's rating AS OF THE WINDOW START — read from the last change at or
    # before it, so this point is deliberately from OUTSIDE the requested window
    # and carries an `at` older than the window's left edge. It is what makes the
    # headline "+127 over 90 days" true when the first in-window match was on day
    # forty. A future reader finding it out of range must not "fix" it (ADR-0915).
    #
    # ``None`` when the player held no rating at that instant — they had not
    # finished a rated match yet — in which case the chart starts at the first
    # in-window point.
    anchor: RatingPoint | None = None
    # Every rating change INSIDE the window, oldest first. Empty is a first-class
    # state, not an error: a rated player who has not played in ninety days gets
    # their anchor and no points, and the chart draws a flat line at their current
    # rating. A **voided match** is simply absent — voiding deletes its history
    # rows, so it is absent from the rating timeline rather than skipped by it
    # (CONTEXT.md, "Voided match").
    points: list[RatingPoint] = []
    # The highest point WITHIN the window — not the all-time peak, which is
    # `PlayerDetail.peak` and is a different number. ``None`` when the window
    # holds no points.
    peak: RatingPoint | None = None
    # The net rating change across the window, measured FROM THE ANCHOR (or, when
    # there is none, from the first in-window point) to the latest point.
    #
    # ``None``, never ``0.0``, when the window holds no points: a zero would claim
    # the player played and moved nothing. An idle window has no delta to report.
    change: float | None = None

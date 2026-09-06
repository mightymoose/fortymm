"""Coverage for the rating system: strategies, calculator math, validation,
and the match-completion hook."""

import ast
import pathlib
import uuid

import jsonschema
import pytest
from httpx import AsyncClient
from sqlalchemy import event, select
from sqlalchemy.exc import IntegrityError, MissingGreenlet
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from app.match_serialization import load_match_eager as _load_match
from app.matches import (
    match_eager_options,
    match_rating_eager_options,
)
from app.models import (
    League,
    Match,
    MatchSettings,
    MatchSide,
    MatchSidePlayer,
    MatchStatus,
    RatingHistory,
    RatingHistorySource,
    RatingStrategy,
    User,
    UserLeagueRating,
)
from app.ratings import (
    STRATEGIES,
    RatingStrategyMismatchError,
    get_calculator,
    state_rating_value,
    validate_state,
)
from app.ratings.glicko2 import CALCULATOR as GLICKO2
from app.result_acceptance import _apply_rating_update
from tests._helpers import (
    accept_standing_result,
    make_user,
    opponent_session,
    start_session,
)

# ----- strategy seeding ----------------------------------------------------


async def test_rating_strategies_are_seeded(
    rating_strategies: dict[str, RatingStrategy],
):
    """The conftest fixture mirrors the migration's seed inserts. Two
    canonical strategies are present and shaped correctly."""
    assert set(rating_strategies) == {"glicko2", "manual"}

    glicko2 = rating_strategies["glicko2"]
    assert glicko2.is_automatic is True
    assert glicko2.initial_rating_value == 1500.0
    assert glicko2.initial_state == {"rating": 1500.0, "rd": 350.0, "volatility": 0.06}

    manual = rating_strategies["manual"]
    assert manual.is_automatic is False
    assert manual.initial_state is None
    assert manual.initial_rating_value is None


def test_registry_only_contains_automatic_strategies():
    """``manual`` has no calculator — the hook treats it as a no-op."""
    assert "glicko2" in STRATEGIES
    assert "manual" not in STRATEGIES
    assert get_calculator("manual") is None


# ----- Glicko-2 calculator -------------------------------------------------


def test_glicko2_winner_gains_loser_loses():
    """Two evenly-rated default players: the winner gains, the loser loses
    a roughly symmetric amount, and both RDs shrink (we learned something)."""
    initial = {"rating": 1500.0, "rd": 350.0, "volatility": 0.06}
    new_winner, new_loser = GLICKO2.update_singles(initial, dict(initial))

    assert new_winner["rating"] > 1500.0
    assert new_loser["rating"] < 1500.0
    assert new_winner["rd"] < initial["rd"]
    assert new_loser["rd"] < initial["rd"]
    # Symmetric matchup → symmetric magnitude.
    assert abs((new_winner["rating"] - 1500) + (new_loser["rating"] - 1500)) < 0.01


def test_glicko2_upset_moves_more_than_expected_win():
    """Beating a much higher-rated opponent shifts ratings further than
    beating a peer — the Glicko-2 information gain is larger."""
    initial = {"rating": 1500.0, "rd": 200.0, "volatility": 0.06}
    expected_winner, _ = GLICKO2.update_singles(initial, dict(initial))
    upset_winner, _ = GLICKO2.update_singles(
        {"rating": 1300.0, "rd": 200.0, "volatility": 0.06},
        {"rating": 1700.0, "rd": 200.0, "volatility": 0.06},
    )
    assert (upset_winner["rating"] - 1300.0) > (expected_winner["rating"] - 1500.0)


def test_state_rating_value_reads_the_rating_key():
    assert state_rating_value({"rating": 1234.5, "rd": 100.0}) == 1234.5


# ----- validation ----------------------------------------------------------


def test_validate_state_accepts_initial_states(
    rating_strategies: dict[str, RatingStrategy],
):
    glicko2 = rating_strategies["glicko2"]
    validate_state(glicko2.initial_state, glicko2)  # type: ignore[arg-type]
    # Manual schema accepts a bare {rating} payload.
    validate_state({"rating": 1750.0}, rating_strategies["manual"])


def test_validate_state_rejects_missing_required_key(
    rating_strategies: dict[str, RatingStrategy],
):
    with pytest.raises(jsonschema.ValidationError):
        validate_state({"rating": 1500.0}, rating_strategies["glicko2"])


def test_validate_state_rejects_extra_keys(
    rating_strategies: dict[str, RatingStrategy],
):
    with pytest.raises(jsonschema.ValidationError):
        validate_state(
            {"rating": 1500.0, "rd": 350.0, "volatility": 0.06, "extra": 1},
            rating_strategies["glicko2"],
        )


# ----- hook: doubles tripwire ----------------------------------------------


async def test_doubles_match_rating_update_raises_not_implemented(
    db_session: AsyncSession,
    default_league: League,
):
    """A completed, rated, automatic-strategy match with ``team_size != 1``
    must fail loud rather than silently skip its rating update — the calculator
    only knows singles. Match creation hardcodes team_size=1 so this is
    unreachable today; the guard trips the moment doubles support lands without
    a doubles-aware calculator (issue #183)."""
    winner = await make_user(db_session, "doubles-winner")
    loser = await make_user(db_session, "doubles-loser")

    settings = MatchSettings(team_size=2, best_of=1, affects_rating=True)
    match = Match(
        match_settings=settings,
        league=default_league,
        created_by_user_id=winner.id,
        status=MatchStatus.completed,
    )
    side1 = MatchSide(match=match, side_number=1, won=True, score=1)
    side1.players.append(MatchSidePlayer(match=match, user=winner.primary_player))
    side2 = MatchSide(match=match, side_number=2, won=False, score=0)
    side2.players.append(MatchSidePlayer(match=match, user=loser.primary_player))
    db_session.add(match)
    await db_session.commit()

    loaded = await _load_match(db_session, match.id)
    assert loaded is not None
    with pytest.raises(NotImplementedError, match="doubles"):
        await _apply_rating_update(db_session, loaded)

    # Nothing was written — the guard fires before any history row.
    rows = (
        (
            await db_session.execute(
                select(RatingHistory).where(RatingHistory.match_id == match.id)
            )
        )
        .scalars()
        .all()
    )
    assert rows == []


# ----- hook: strategy-snapshot mismatch guard (issue #184) -----------------


async def _make_second_automatic_strategy(db_session: AsyncSession) -> RatingStrategy:
    """A second ``is_automatic`` strategy with its own incompatible state shape.
    Only glicko2 has a registered calculator, so this stands in as the *old*
    strategy a ``user_league_ratings`` row was snapshotted under; the league still
    runs glicko2 (the live calculator), whose schema the old state would violate.
    The guard fires on this automatic->automatic difference (see #184)."""
    strategy = RatingStrategy(
        key="glicko2_experimental",
        name="Experimental (test only)",
        description="Second automatic strategy with an incompatible state shape.",
        state_schema={
            "type": "object",
            "required": ["score"],
            "properties": {"score": {"type": "number"}},
            "additionalProperties": False,
        },
        initial_state={"score": 1000.0},
        initial_rating_value=1000.0,
        is_automatic=True,
    )
    db_session.add(strategy)
    await db_session.commit()
    await db_session.refresh(strategy)
    return strategy


async def _build_completed_singles_match(
    db_session: AsyncSession,
    league: League,
    winner: User,
    loser: User,
) -> Match:
    settings = MatchSettings(team_size=1, best_of=1, affects_rating=True)
    match = Match(
        match_settings=settings,
        league=league,
        created_by_user_id=winner.id,
        status=MatchStatus.completed,
    )
    side1 = MatchSide(match=match, side_number=1, won=True, score=1)
    side1.players.append(MatchSidePlayer(match=match, user=winner.primary_player))
    side2 = MatchSide(match=match, side_number=2, won=False, score=0)
    side2.players.append(MatchSidePlayer(match=match, user=loser.primary_player))
    db_session.add(match)
    await db_session.commit()
    return match


async def test_rating_hook_refuses_row_snapshotted_under_a_different_strategy(
    db_session: AsyncSession,
    default_league: League,
    rating_strategies: dict[str, RatingStrategy],
):
    """When a player's rating row was snapshotted under a *different* automatic
    strategy than the league now runs, the live rating hook must raise
    ``RatingStrategyMismatchError`` — not a jsonschema ``ValidationError``, and
    not a silent write reinterpreting the old state under the new schema (#184)."""
    glicko2 = rating_strategies["glicko2"]
    other = await _make_second_automatic_strategy(db_session)
    assert default_league.rating_strategy_id == glicko2.id

    winner = await make_user(db_session, "hook-mismatch-w")
    loser = await make_user(db_session, "hook-mismatch-l")
    # Snapshot both rows under the OTHER strategy — a league that switched away
    # from it to glicko2 after these rows were written.
    for user in (winner, loser):
        db_session.add(
            UserLeagueRating.seed_for_strategy(default_league.id, user.id, other)
        )
    await db_session.commit()

    match = await _build_completed_singles_match(
        db_session, default_league, winner, loser
    )
    loaded = await _load_match(db_session, match.id)
    assert loaded is not None

    with pytest.raises(RatingStrategyMismatchError) as exc_info:
        await _apply_rating_update(db_session, loaded)

    err = exc_info.value
    assert err.league_id == default_league.id
    assert err.user_id in {winner.id, loser.id}
    assert err.row_strategy_id == other.id
    assert err.league_strategy_id == glicko2.id

    # Nothing was written — the guard fires before any history row.
    rows = (
        (
            await db_session.execute(
                select(RatingHistory).where(RatingHistory.match_id == match.id)
            )
        )
        .scalars()
        .all()
    )
    assert rows == []


async def test_rating_hook_freshly_seeded_row_does_not_raise(
    db_session: AsyncSession,
    default_league: League,
    rating_strategies: dict[str, RatingStrategy],
):
    """A row this hook *creates* is stamped with the league's current strategy,
    so it can never mismatch — the guard must not fire on it (#184, subtlety a).
    Neither player has a pre-existing rating row here, so both are freshly seeded
    under glicko2 and the update applies normally."""
    glicko2 = rating_strategies["glicko2"]
    await _make_second_automatic_strategy(db_session)

    winner = await make_user(db_session, "hook-fresh-w")
    loser = await make_user(db_session, "hook-fresh-l")
    match = await _build_completed_singles_match(
        db_session, default_league, winner, loser
    )
    loaded = await _load_match(db_session, match.id)
    assert loaded is not None

    await _apply_rating_update(db_session, loaded)
    await db_session.commit()

    ratings = (
        (
            await db_session.execute(
                select(UserLeagueRating).where(
                    UserLeagueRating.user_id.in_([winner.id, loser.id])
                )
            )
        )
        .scalars()
        .all()
    )
    assert len(ratings) == 2
    assert {r.rating_strategy_id for r in ratings} == {glicko2.id}
    rows = (
        (
            await db_session.execute(
                select(RatingHistory).where(RatingHistory.match_id == match.id)
            )
        )
        .scalars()
        .all()
    )
    assert len(rows) == 2


# ----- hook: end-to-end through the score endpoint -------------------------


async def _score_to_completion(
    client: AsyncClient,
    opp_client: AsyncClient,
    opp_id: uuid.UUID,
    best_of: int = 1,
) -> dict:
    """Create a rated match and run the full post + confirm dance —
    ``client``'s user (side 1) wins. Rating updates apply on the confirm
    call. Returns the post-finalization MatchDetails *as seen by* ``client``
    (so ``is_current_user_side`` flags reflect the original poster, which is
    what most callers want to assert against)."""
    create = await client.post(
        "/v1/matches",
        json={
            "opponent_user_id": str(opp_id),
            "best_of": best_of,
            "rated": True,
        },
    )
    assert create.status_code == 201
    match = create.json()
    needed = best_of // 2 + 1
    post = await client.post(
        f"/v1/matches/{match['id']}/results",
        json={
            "games": [
                {"game_number": n, "side_1_points": 11, "side_2_points": 4}
                for n in range(1, needed + 1)
            ]
        },
    )
    assert post.status_code == 201
    await accept_standing_result(opp_client, match["id"])
    final = await client.get(f"/v1/matches/{match['id']}")
    assert final.status_code == 200
    body = final.json()
    assert body["status"] == "completed"
    return body


async def test_completing_a_rated_match_writes_rating_history(
    api_client: AsyncClient,
    db_session: AsyncSession,
    default_league: League,
):
    me = await start_session(api_client, db_session)
    async with opponent_session(db_session, "rival") as (opp_client, opp):
        body = await _score_to_completion(api_client, opp_client, opp.id)

        # Two history rows, one per player, both linked to this match.
        rows = (
            (
                await db_session.execute(
                    select(RatingHistory).where(
                        RatingHistory.match_id == uuid.UUID(body["id"])
                    )
                )
            )
            .scalars()
            .all()
        )
        assert len(rows) == 2
        by_user = {row.user_id: row for row in rows}
        winner = by_user[me.id]
        loser = by_user[opp.id]

        assert winner.source == RatingHistorySource.match
        assert loser.source == RatingHistorySource.match
        assert winner.previous_rating_value == 1500.0
        assert loser.previous_rating_value == 1500.0
        assert winner.rating_value > 1500.0
        assert loser.rating_value < 1500.0
        assert winner.rating_strategy_id == default_league.rating_strategy_id

        # Current rating rows are upserted in lockstep.
        ratings = (await db_session.execute(select(UserLeagueRating))).scalars().all()
        assert {r.user_id for r in ratings} >= {me.id, opp.id}
        assert {r.league_id for r in ratings} == {default_league.id}


async def test_ratings_only_apply_on_confirmation_not_results(
    api_client: AsyncClient,
    db_session: AsyncSession,
):
    """The post-#345 finalize moved ratings out of /results. In the propose/
    accept model, ratings hold off until the opposing side accepts — the
    /results (propose) call itself leaves the result standing, unrated."""
    await start_session(api_client, db_session)
    async with opponent_session(db_session, "delay-opp") as (opp_client, opp):
        create = await api_client.post(
            "/v1/matches",
            json={
                "opponent_user_id": str(opp.id),
                "best_of": 1,
                "rated": True,
            },
        )
        match = create.json()
        post = await api_client.post(
            f"/v1/matches/{match['id']}/results",
            json={
                "games": [
                    {"game_number": 1, "side_1_points": 11, "side_2_points": 4},
                ]
            },
        )
        assert post.status_code == 201
        # No rating rows yet — opponent hasn't confirmed.
        rows_after_post = (
            (
                await db_session.execute(
                    select(RatingHistory).where(
                        RatingHistory.match_id == uuid.UUID(match["id"])
                    )
                )
            )
            .scalars()
            .all()
        )
        assert rows_after_post == []

        await accept_standing_result(opp_client, match["id"])
        rows_after_confirm = (
            (
                await db_session.execute(
                    select(RatingHistory).where(
                        RatingHistory.match_id == uuid.UUID(match["id"])
                    )
                )
            )
            .scalars()
            .all()
        )
        assert len(rows_after_confirm) == 2


def _changes(body: dict) -> tuple[dict, dict]:
    """``(mine, theirs)`` rating changes off a MatchDetails body, both asserted
    present — the caller is about to make claims about their contents."""
    mine = next(s for s in body["sides"] if s["is_current_user_side"])["rating_change"]
    theirs = next(s for s in body["sides"] if not s["is_current_user_side"])[
        "rating_change"
    ]
    assert mine is not None
    assert theirs is not None
    return mine, theirs


def test_previous_rating_value_is_read_in_exactly_one_place():
    """``RatingHistory.previous_rating_value`` may be READ in ONE module, and this
    test is the fence around it.

    The phantom 1500 (#952) came back four times because it is not a bug in one
    widget — it is a bug that any reader of this column re-derives on its own. The
    column holds the state the Glicko-2 update STARTED FROM, which for a player's
    first rated match is the prior their league-join seeded them with. Subtract it
    and you have just told a brand-new player they lost 232 points of a rating they
    never held. Four surfaces did exactly that, one at a time: the match-details
    chip, the profile's Δ column, the dashboard's Recent-matches Δ, and finally the
    dashboard hero — each fixed in turn while the next one sat there re-deriving it,
    because nothing stopped a reader from reaching for the raw column.

    So the read side has exactly ONE door: ``app.ratings.rated`` — whose
    ``reported_rating_before(row, *, had_rating_before)`` demands the flag
    (keyword-only, no default — the question cannot be skipped) and resolves the
    seeded prior to ``None``. Everything a surface can then do with the result
    derives itself: ``RatingChange.delta`` is a computed field / property over
    ``before`` and ``after`` (``app.domain.rating.rating_delta``), so a change that
    reports a fall from a rating the player never held is not constructible.

    THE DOOR MOVED, AND THE FENCE MOVED WITH IT. It used to be
    ``schemas.rating.RatingChange.from_history`` — the wire model — which worked
    only while the wire model was the sole path to a rating change. It no longer is:
    the match-details extras now load through ``MatchDetailsRepository`` (ADR-0015)
    and build the *domain* ``RatingChange``, which is not the pydantic one and
    cannot be reached through it. Two column readers would have been two chances to
    re-derive the phantom — so the read was extracted DOWN into ``ratings/rated.py``,
    next to the ``had_rating_before()`` predicate that feeds it, and both surfaces
    (wire schema and repository) now come through that one function. One reader,
    relocated — not one reader per surface.

    This asserts the door is the only one. An ``ast.Attribute`` load of the name —
    ``row.previous_rating_value``, ``select(RatingHistory.previous_rating_value)``,
    the two shapes every one of those four bugs took — is allowed in
    ``app/ratings/rated.py`` and nowhere else. The WRITE side is untouched and
    deliberately invisible here: it passes the value as a keyword argument
    (``previous_rating_value=...``), which is an ``ast.keyword``, not an attribute
    load. ``result_acceptance``, ``recompute`` and ``leagues`` go on recording the
    truth; only the reading of it is fenced.

    If you are here because this test failed: you do not want the raw column. You
    want ``reported_rating_before(row, had_rating_before=...)``, with
    ``app.ratings.rated.had_rating_before()`` selected alongside your row — that is
    what both read-side surfaces do.
    """
    app_dir = pathlib.Path(__file__).resolve().parent.parent / "app"
    readers = {
        path.relative_to(app_dir).as_posix()
        for path in app_dir.rglob("*.py")
        for node in ast.walk(ast.parse(path.read_text()))
        if isinstance(node, ast.Attribute)
        and node.attr == "previous_rating_value"
        and isinstance(node.ctx, ast.Load)
    }
    assert readers == {"ratings/rated.py"}


async def test_match_details_first_rated_match_establishes_a_rating_not_a_fall(
    api_client: AsyncClient, db_session: AsyncSession
):
    """A player's FIRST rated match ESTABLISHES their rating — it does not drop them
    from the 1500 their league-join seeded (#952).

    Both players here are session-minted, so they carry the real thing: a
    ``UserLeagueRating`` at 1500 and an ``initial`` history row, exactly as
    production writes at signup. The Glicko-2 update genuinely starts from that seed
    and ``previous_rating_value`` records it — the assertions on ``rating_value``
    below only make sense because it does. What must not happen is the READ side
    narrating it: "1500 → 1268, −232" told the loser they lost 232 points of a
    rating they never held, inches from the pre-match snapshot on the same page
    correctly calling them Unrated.

    So: no ``before``, no ``delta``. Just the rating they came out with.

    The seed is what gives this test its teeth. A fix that merely looked for "an
    earlier rating-history row" would find the ``initial`` one and go right on
    reporting 1500 → the predicate has to know that the seed is not a rating.
    """
    await start_session(api_client, db_session)
    async with opponent_session(db_session, "rival") as (opp_client, opp):
        body = await _score_to_completion(api_client, opp_client, opp.id)

    my_change, opp_change = _changes(body)

    # Unrated → 1524. Not 1500 → 1524.
    assert my_change["before"] is None
    assert my_change["delta"] is None
    assert my_change["after"] > 1500.0

    # And the loser — the shape QA caught — is established, not knocked down.
    assert opp_change["before"] is None
    assert opp_change["delta"] is None
    assert opp_change["after"] < 1500.0

    # The WRITE side is untouched: the maths still starts from the seed, which is
    # what makes the two `after` values above land either side of 1500.
    rows = (
        (
            await db_session.execute(
                select(RatingHistory).where(
                    RatingHistory.match_id == uuid.UUID(body["id"])
                )
            )
        )
        .scalars()
        .all()
    )
    assert {row.previous_rating_value for row in rows} == {1500.0}


async def test_match_details_second_rated_match_reports_the_real_move(
    api_client: AsyncClient, db_session: AsyncSession
):
    """Once a player HAS a rating, a rated match MOVES it — and that move is reported
    in full.

    The counterweight to the test above: suppressing every ``before``/``delta``
    would satisfy that one and be just as wrong. Here the second match's ``before``
    is the rating the FIRST one established — an earned number, not a seeded one —
    so a real delta is exactly what the widget must show.
    """
    await start_session(api_client, db_session)
    async with opponent_session(db_session, "rival") as (opp_client, opp):
        first = await _score_to_completion(api_client, opp_client, opp.id)
        second = await _score_to_completion(api_client, opp_client, opp.id)

    first_change, _ = _changes(first)
    my_change, opp_change = _changes(second)

    # Their first match gave them a rating; this one moves it.
    assert my_change["before"] == first_change["after"]
    assert my_change["before"] != 1500.0
    assert my_change["delta"] == pytest.approx(my_change["after"] - my_change["before"])
    assert my_change["delta"] > 0

    assert opp_change["before"] is not None
    assert opp_change["delta"] is not None
    assert opp_change["delta"] < 0


async def test_unrated_match_does_not_move_ratings(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    async with opponent_session(db_session, "rival") as (_opp_client, opp):
        create = await api_client.post(
            "/v1/matches",
            json={
                "opponent_user_id": str(opp.id),
                "best_of": 1,
                "rated": False,
            },
        )
        match = create.json()
        post = await api_client.post(
            f"/v1/matches/{match['id']}/results",
            json={
                "games": [
                    {"game_number": 1, "side_1_points": 11, "side_2_points": 4},
                ]
            },
        )
        assert post.status_code == 201
        # Unrated matches skip the confirmation gate (#485) and finalize
        # straight from /results.
        body = post.json()
        assert body["status"] == "completed"
        for side in body["sides"]:
            assert side["rating_change"] is None

        # The session user has an `initial` seed row from joining the league,
        # but an unrated match must not produce any `match`-sourced history.
        rows = (
            (
                await db_session.execute(
                    select(RatingHistory).where(
                        RatingHistory.source == RatingHistorySource.match
                    )
                )
            )
            .scalars()
            .all()
        )
        assert rows == []


async def test_manual_strategy_league_skips_rating_updates(
    api_client: AsyncClient,
    db_session: AsyncSession,
    rating_strategies: dict[str, RatingStrategy],
):
    """Replace the default league's strategy with ``manual`` and confirm the
    hook quietly skips. New members still get rating rows on join (the league
    membership hook eagerly seeds them), but with the strategy's null
    ``initial_state`` — to be filled by a later external import."""
    default = (
        await db_session.execute(select(League).where(League.is_default.is_(True)))
    ).scalar_one()
    default.rating_strategy_id = rating_strategies["manual"].id
    await db_session.commit()

    await start_session(api_client, db_session)
    async with opponent_session(db_session, "rival") as (opp_client, opp):
        body = await _score_to_completion(api_client, opp_client, opp.id)
        my_side = next(s for s in body["sides"] if s["is_current_user_side"])
        assert my_side["rating_change"] is None

        rows = (
            (
                await db_session.execute(
                    select(RatingHistory).where(
                        RatingHistory.source == RatingHistorySource.match
                    )
                )
            )
            .scalars()
            .all()
        )
        assert rows == []

        # Both session users have an `initial` seed row from joining the
        # (now manual) default league, but with the strategy's null state.
        ratings = (await db_session.execute(select(UserLeagueRating))).scalars().all()
        assert all(r.rating_value is None for r in ratings)
        assert all(r.rating_state is None for r in ratings)


async def test_finalized_match_rejects_score_edits_and_keeps_rating_history(
    api_client: AsyncClient, db_session: AsyncSession
):
    """Once a match is finalized (both signatures, status=completed) every
    write path 409s — there's no way to silently re-apply (or duplicate) the
    rating update. Re-applying ratings after a correction is its own feature
    (tied to dispute/void flows), explicitly out of scope for v1."""
    await start_session(api_client, db_session)
    async with opponent_session(db_session, "rival") as (opp_client, opp):
        body = await _score_to_completion(api_client, opp_client, opp.id)

        # Every score-write path is locked once the match is finalized.
        put = await api_client.put(
            f"/v1/matches/{body['id']}/games/1/scores",
            json={"side_1_points": 11, "side_2_points": 5, "expected_version": 1},
        )
        assert put.status_code == 409
        re_finalize = await api_client.post(
            f"/v1/matches/{body['id']}/results",
            json={
                "games": [
                    {"game_number": 1, "side_1_points": 11, "side_2_points": 5},
                ]
            },
        )
        assert re_finalize.status_code == 409

        rows = (
            (
                await db_session.execute(
                    select(RatingHistory).where(
                        RatingHistory.match_id == uuid.UUID(body["id"])
                    )
                )
            )
            .scalars()
            .all()
        )
        assert len(rows) == 2  # still just the original pair from finalize


async def test_new_session_seeds_rating_for_default_league(
    api_client: AsyncClient,
    db_session: AsyncSession,
    default_league: League,
):
    """Starting a session creates the user, attaches them to the default
    league, and seeds a rating row with the strategy's initial values — so
    new players have a visible rating from day one without having to play
    a match first."""
    me = await start_session(api_client, db_session)

    rating = (
        await db_session.execute(
            select(UserLeagueRating).where(
                UserLeagueRating.user_id == me.id,
                UserLeagueRating.league_id == default_league.id,
            )
        )
    ).scalar_one()
    assert rating.rating_value == 1500.0
    assert rating.rating_state == {"rating": 1500.0, "rd": 350.0, "volatility": 0.06}


async def test_manual_history_row_with_null_match_round_trips(
    db_session: AsyncSession,
    default_league: League,
    rating_strategies: dict[str, RatingStrategy],
):
    """A manual override / external import path can write a history row with
    no match link and a non-null ``created_by_user_id`` + ``note``."""
    admin = await make_user(db_session, "admin")
    player = await make_user(db_session, "player")

    row = RatingHistory(
        league_id=default_league.id,
        user_id=player.id,
        match_id=None,
        rating_strategy_id=rating_strategies["manual"].id,
        rating_value=1850.0,
        rating_state={"rating": 1850.0},
        previous_rating_value=None,
        source=RatingHistorySource.import_,
        note="USATT 2026-04 batch",
        created_by_user_id=admin.id,
    )
    db_session.add(row)
    await db_session.commit()

    reloaded = (
        await db_session.execute(
            select(RatingHistory).where(RatingHistory.user_id == player.id)
        )
    ).scalar_one()
    assert reloaded.match_id is None
    assert reloaded.source == RatingHistorySource.import_
    assert reloaded.note == "USATT 2026-04 batch"
    assert reloaded.created_by_user_id == admin.id


async def test_rating_history_rejects_duplicate_match_user_row(
    api_client: AsyncClient,
    db_session: AsyncSession,
    default_league: League,
):
    """The partial ``UNIQUE(match_id, user_id)`` index makes a concurrent
    double-completion fail loudly instead of writing a second history-row pair
    (and double-applying the rating) for the same match + player."""
    await start_session(api_client, db_session)
    async with opponent_session(db_session, "rival") as (opp_client, opp):
        await _score_to_completion(api_client, opp_client, opp.id)

    existing = (
        await db_session.execute(
            select(RatingHistory)
            .where(RatingHistory.source == RatingHistorySource.match)
            .limit(1)
        )
    ).scalar_one()

    dup = RatingHistory(
        league_id=existing.league_id,
        user_id=existing.user_id,
        match_id=existing.match_id,
        rating_strategy_id=existing.rating_strategy_id,
        rating_value=existing.rating_value,
        rating_state=existing.rating_state,
        previous_rating_value=existing.previous_rating_value,
        source=RatingHistorySource.match,
    )
    db_session.add(dup)
    with pytest.raises(IntegrityError):
        await db_session.flush()


async def test_match_rating_eager_options_loads_the_strategy_write_paths_need(
    api_client: AsyncClient,
    db_session: AsyncSession,
    default_league: League,
    engine: AsyncEngine,
):
    """Guards the explicit ``League.rating_strategy`` load on the score-write
    finalize paths (issue #182). The shared ``match_eager_options()`` read chain
    deliberately does NOT eager-load the strategy — only ``_apply_rating_update``
    reads it — so the two finalize handlers load it via
    ``match_rating_eager_options()``. Under async SQLAlchemy a lazy access on the
    unloaded ``league.rating_strategy`` raises ``MissingGreenlet`` at runtime, a
    production 500 that mypy and a naive test can't catch.

    THIS TEST OPENS ITS OWN FRESH ``async_sessionmaker(engine)`` SESSION ON
    PURPOSE. The ``api_client`` shares the per-test ``db_session`` (whose
    ``expire_on_commit=False`` keeps loaded relationships resident), so match
    creation's ``resolve_league`` already populates ``league.rating_strategy`` in
    that session's identity map — masking the bug entirely. A real HTTP request
    gets a fresh session with an empty identity map, which is what this fresh
    sessionmaker reproduces. Without it, dropping the load from
    ``match_rating_eager_options()`` would leave every test green while score
    submission 500s in production."""
    await start_session(api_client, db_session)
    async with opponent_session(db_session, "rival") as (opp_client, opp):
        body = await _score_to_completion(api_client, opp_client, opp.id)
    match_id = uuid.UUID(body["id"])

    fresh_session = async_sessionmaker(engine)  # default: empty identity map

    # (i) The shared read chain must NOT emit a rating_strategies SELECT; the
    # write chain must emit exactly one.
    async def strategy_selects(options: object) -> int:
        seen: list[str] = []

        def before(conn: object, cursor: object, statement: str, *args: object) -> None:
            if "rating_strategies" in statement:
                seen.append(statement)

        event.listen(engine.sync_engine, "before_cursor_execute", before)
        try:
            async with fresh_session() as s:
                await _load_match(s, match_id, options=options)  # type: ignore[arg-type]
        finally:
            event.remove(engine.sync_engine, "before_cursor_execute", before)
        return len(seen)

    assert await strategy_selects(match_eager_options()) == 0
    assert await strategy_selects(match_rating_eager_options()) == 1

    # (ii) The read chain leaves the strategy unloaded → lazy access blows up.
    async with fresh_session() as s:
        read_only = await _load_match(s, match_id, options=match_eager_options())
        assert read_only is not None
        with pytest.raises(MissingGreenlet):
            _ = read_only.league.rating_strategy.is_automatic

    # (ii) The write chain has it loaded → _apply_rating_update runs clean.
    async with fresh_session() as s:
        ready = await _load_match(s, match_id, options=match_rating_eager_options())
        assert ready is not None
        assert ready.league.rating_strategy.is_automatic is True
        await _apply_rating_update(s, ready)  # idempotent no-op; touches strategy


async def test_rating_history_allows_many_null_match_rows_per_user(
    db_session: AsyncSession,
    default_league: League,
    rating_strategies: dict[str, RatingStrategy],
):
    """The unique index is partial on ``match_id IS NOT NULL``, so a user can
    hold multiple manual/import/initial rows (all with a NULL ``match_id``)
    without tripping it."""
    player = await make_user(db_session, "player")
    for value in (1500.0, 1600.0):
        db_session.add(
            RatingHistory(
                league_id=default_league.id,
                user_id=player.id,
                match_id=None,
                rating_strategy_id=rating_strategies["manual"].id,
                rating_value=value,
                rating_state={"rating": value},
                previous_rating_value=None,
                source=RatingHistorySource.manual,
            )
        )
    await db_session.commit()

    rows = (
        (
            await db_session.execute(
                select(RatingHistory).where(RatingHistory.user_id == player.id)
            )
        )
        .scalars()
        .all()
    )
    assert len(rows) == 2

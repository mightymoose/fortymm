import asyncio
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from fastapi import HTTPException
from httpx import AsyncClient
from rq import Queue
from sqlalchemy import event, select, update
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker
from sqlalchemy.orm import selectinload
from sqlalchemy.sql.base import ExecutableOption

from app import matches as matches_mod
from app.domain.match.extras import CareerRecord, PreMatchRating
from app.match_voiding import void_match
from app.matches import (
    _compact_games,
    accept_match_result,
    create_game_score,
    delete_game_score,
    post_match_result,
    update_game_score,
)
from app.models import (
    League,
    LeagueVisibility,
    Match,
    MatchGame,
    MatchGameScore,
    MatchResult,
    MatchSettings,
    MatchSide,
    MatchSidePlayer,
    MatchStatus,
    RatingHistory,
    RatingHistorySource,
    RatingStrategy,
    User,
)
from app.notifications.apns import MATCH_RESULT_CONFIRMATION_CATEGORY
from app.notifications.service import NotificationService
from app.repositories.match_details_repository import (
    RATING_HISTORY_LIMIT,
    MatchDetailsRepository,
)
from app.repositories.match_repository import MatchRepository
from app.schemas.match import (
    MatchGameScoreUpdate,
    MatchGameScoreWrite,
    MatchResultsGameWrite,
    MatchResultsWrite,
)
from app.services.match_service import MatchService
from tests._helpers import (
    FakeSender,
    accept_standing_result,
    enqueued_notification_jobs,
    make_client,
    make_user,
    opponent_session,
    start_session,
)


def _match_service(session: AsyncSession) -> MatchService:
    """The wiring ``get_match_service`` would do for a request. The concurrency
    tests below drive the score-write handlers as plain functions on their own
    real sessions (bypassing FastAPI's DI), so they construct the service the
    handlers now depend on themselves."""
    return MatchService(MatchRepository(session), MatchDetailsRepository(session))


# ----- decided-board compaction (#742) ------------------------------------


def _game(n: int, s1: int = 11, s2: int = 2) -> MatchResultsGameWrite:
    return MatchResultsGameWrite(game_number=n, side_1_points=s1, side_2_points=s2)


def test_compact_games_closes_a_gap():
    # The #742 out-of-order clinch: game 4 blank, deciding win scored on game 5.
    compacted = _compact_games([_game(1), _game(2), _game(3), _game(5)])
    assert [g.game_number for g in compacted] == [1, 2, 3, 4]


def test_compact_games_is_identity_on_a_contiguous_board():
    compacted = _compact_games([_game(1), _game(2), _game(3)])
    assert [g.game_number for g in compacted] == [1, 2, 3]


def test_compact_games_leaves_an_overrun_untouched():
    # A fully-scored board with no holes has nothing to compact — a real overrun
    # ([1..5] where the match was already won at game 4) stays [1..5] so the
    # strict validator still rejects it.
    compacted = _compact_games([_game(n) for n in range(1, 6)])
    assert [g.game_number for g in compacted] == [1, 2, 3, 4, 5]


def test_compact_games_preserves_duplicates_and_scores():
    # Compaction ranks by distinct game number, so a duplicate stays a duplicate
    # (the strict validator still catches it) and each game keeps its own score.
    compacted = _compact_games([_game(3, 11, 7), _game(1, 11, 4), _game(1, 5, 11)])
    assert [g.game_number for g in compacted] == [1, 1, 2]
    # Sorted-stable: game 1's two scores keep their order; game 3 → game 2.
    assert (compacted[2].side_1_points, compacted[2].side_2_points) == (11, 7)


# ----- create -------------------------------------------------------------


async def test_create_match_requires_a_session(api_client: AsyncClient):
    response = await api_client.post("/v1/matches", json={"best_of": 5})
    assert response.status_code == 401


async def test_create_rated_match_with_registered_opponent(
    api_client: AsyncClient, db_session: AsyncSession
):
    me = await start_session(api_client, db_session)
    opponent = await make_user(db_session, "rival")

    response = await api_client.post(
        "/v1/matches",
        json={
            "opponent_user_id": str(opponent.id),
            "best_of": 5,
            "rated": True,
        },
    )
    assert response.status_code == 201
    body = response.json()
    assert body["status"] == "in_progress"
    assert body["status_label"] == "Live"
    assert body["best_of"] == 5
    assert body["games_to_win"] == 3
    assert body["team_size"] == 1
    assert body["affects_rating"] is True

    assert [s["side_number"] for s in body["sides"]] == [1, 2]
    my_side, opp_side = body["sides"]
    assert my_side["is_current_user_side"] is True
    assert my_side["players"][0]["user_id"] == str(me.id)
    assert my_side["players"][0]["is_current_user"] is True
    assert my_side["games_won"] == 0

    assert opp_side["is_current_user_side"] is False
    assert opp_side["players"][0]["user_id"] == str(opponent.id)
    assert opp_side["players"][0]["is_current_user"] is False

    # Games are written lazily by the score-write endpoints — a freshly
    # created match has no game rows yet, only the deeplink target.
    assert body["games"] == []
    assert body["current_game"]["game_number"] == 1
    assert body["can_score"] is True
    assert body["can_finalize"] is False

    match = (await db_session.execute(select(Match))).scalar_one()
    assert str(match.id) == body["id"]
    games = (await db_session.execute(select(MatchGame))).scalars().all()
    assert games == []


async def test_create_unrated_match_with_opponent(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    opponent = await make_user(db_session, "casual-rival")

    response = await api_client.post(
        "/v1/matches",
        json={
            "opponent_user_id": str(opponent.id),
            "best_of": 3,
            "rated": False,
        },
    )
    assert response.status_code == 201
    body = response.json()
    assert body["affects_rating"] is False
    assert len(body["sides"]) == 2


async def test_create_match_without_opponent_has_a_sentinel_opponent_side(
    api_client: AsyncClient, db_session: AsyncSession
):
    me = await start_session(api_client, db_session)

    response = await api_client.post("/v1/matches", json={"best_of": 7, "rated": False})
    assert response.status_code == 201
    body = response.json()
    assert body["affects_rating"] is False
    # Two sides: the creator, plus a player-less sentinel "No opponent" side.
    sides = sorted(body["sides"], key=lambda s: s["side_number"])
    assert [s["side_number"] for s in sides] == [1, 2]
    assert sides[0]["players"][0]["user_id"] == str(me.id)
    assert sides[1]["players"] == []
    # The sentinel side makes the match scorable for its creator. The first
    # game number is still surfaced even though no MatchGame row exists yet.
    assert body["current_game"] == {"game_number": 1}
    assert body["can_score"] is True
    assert body["can_finalize"] is False

    rows = (await db_session.execute(select(MatchSide))).scalars().all()
    assert len(rows) == 2


async def test_match_without_opponent_can_be_scored_to_completion(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)

    match = (
        await api_client.post("/v1/matches", json={"best_of": 3, "rated": False})
    ).json()
    # Per-game scratchpad writes leave status untouched — the match isn't
    # decided until POST /results.
    after_g1 = (
        await api_client.post(
            f"/v1/matches/{match['id']}/games/1/scores/new",
            json={"side_1_points": 11, "side_2_points": 4},
        )
    ).json()
    assert after_g1["status"] == "in_progress"
    assert after_g1["can_finalize"] is False
    after_g2 = (
        await api_client.post(
            f"/v1/matches/{match['id']}/games/2/scores/new",
            json={"side_1_points": 11, "side_2_points": 7},
        )
    ).json()
    assert after_g2["status"] == "in_progress"
    # Two same-winner games in a best-of-3 → the saved scores form a decided
    # match, so the FE's submit button will swap to "Finalize match".
    assert after_g2["can_finalize"] is True

    finalized = await api_client.post(
        f"/v1/matches/{match['id']}/results",
        json={
            "games": [
                {"game_number": 1, "side_1_points": 11, "side_2_points": 4},
                {"game_number": 2, "side_1_points": 11, "side_2_points": 7},
            ]
        },
    )
    assert finalized.status_code == 201
    body = finalized.json()
    assert body["status"] == "completed"
    sides = sorted(body["sides"], key=lambda s: s["side_number"])
    assert [s["won"] for s in sides] == [True, False]
    # No rating moved — a player-less opponent can't be rated against.
    assert body["affects_rating"] is False
    assert body["current_game"] is None
    assert body["can_score"] is False
    assert body["can_finalize"] is False


async def test_rated_match_without_opponent_is_rejected(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)

    response = await api_client.post("/v1/matches", json={"best_of": 5, "rated": True})
    assert response.status_code == 422
    assert "rated" in response.json()["detail"].lower()
    assert (await db_session.execute(select(Match))).first() is None


async def test_cannot_start_a_match_against_yourself(
    api_client: AsyncClient, db_session: AsyncSession
):
    me = await start_session(api_client, db_session)

    response = await api_client.post(
        "/v1/matches",
        json={"opponent_user_id": str(me.id), "best_of": 5, "rated": True},
    )
    assert response.status_code == 422
    assert "yourself" in response.json()["detail"].lower()


async def test_unknown_opponent_is_rejected(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)

    response = await api_client.post(
        "/v1/matches",
        json={
            "opponent_user_id": str(uuid.uuid4()),
            "best_of": 5,
            "rated": True,
        },
    )
    assert response.status_code == 404
    assert "opponent" in response.json()["detail"].lower()


async def test_merged_away_opponent_is_rejected(
    api_client: AsyncClient, db_session: AsyncSession
):
    """A tombstoned (merged-away) opponent must be treated like an unknown
    one — a rated match must never be minted against a dead account."""
    await start_session(api_client, db_session)
    ghost = await make_user(db_session, "ghost")
    survivor = await make_user(db_session, "survivor")
    ghost.merged_into_user_id = survivor.id
    await db_session.commit()

    response = await api_client.post(
        "/v1/matches",
        json={
            "opponent_user_id": str(ghost.id),
            "best_of": 5,
            "rated": True,
        },
    )
    assert response.status_code == 404
    assert "opponent" in response.json()["detail"].lower()


async def test_even_best_of_is_rejected(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    opponent = await make_user(db_session, "rival")

    response = await api_client.post(
        "/v1/matches",
        json={
            "opponent_user_id": str(opponent.id),
            "best_of": 4,
            "rated": True,
        },
    )
    assert response.status_code == 422


async def test_best_of_rejects_a_numeric_string(
    api_client: AsyncClient, db_session: AsyncSession
):
    """``best_of`` is a strict int: the JSON string "5" is rejected with a 422
    rather than coerced to 5 (which would slip past ``_best_of_allowed``)."""
    await start_session(api_client, db_session)
    opponent = await make_user(db_session, "string-rival")

    response = await api_client.post(
        "/v1/matches",
        json={
            "opponent_user_id": str(opponent.id),
            "best_of": "5",
            "rated": True,
        },
    )
    assert response.status_code == 422


# ----- details ------------------------------------------------------------


async def _create_match(
    client: AsyncClient, opponent_id: uuid.UUID, best_of: int = 5
) -> dict:
    response = await client.post(
        "/v1/matches",
        json={
            "opponent_user_id": str(opponent_id),
            "best_of": best_of,
            "rated": True,
        },
    )
    assert response.status_code == 201
    return response.json()


async def test_get_match_flags_current_user_side(
    api_client: AsyncClient, db_session: AsyncSession
):
    me = await start_session(api_client, db_session)
    opponent = await make_user(db_session, "rival")
    created = await _create_match(api_client, opponent.id)

    response = await api_client.get(f"/v1/matches/{created['id']}")
    assert response.status_code == 200
    body = response.json()
    my_side = next(s for s in body["sides"] if s["is_current_user_side"])
    opp_side = next(s for s in body["sides"] if not s["is_current_user_side"])
    assert my_side["players"][0]["user_id"] == str(me.id)
    assert opp_side["players"][0]["user_id"] == str(opponent.id)


async def test_details_perspective_swaps_per_caller(
    api_client: AsyncClient, db_session: AsyncSession
):
    me = await start_session(api_client, db_session)
    async with make_client() as other_client:
        them = await start_session(other_client, db_session)
        created = await _create_match(api_client, them.id)

        mine = (await api_client.get(f"/v1/matches/{created['id']}")).json()
        theirs = (await other_client.get(f"/v1/matches/{created['id']}")).json()

    my_perspective = next(s for s in mine["sides"] if s["is_current_user_side"])
    their_perspective = next(s for s in theirs["sides"] if s["is_current_user_side"])
    assert my_perspective["players"][0]["user_id"] == str(me.id)
    assert their_perspective["players"][0]["user_id"] == str(them.id)
    # The flag flips per caller, but the underlying side numbers are stable.
    assert my_perspective["side_number"] != their_perspective["side_number"]


async def test_get_match_is_open_to_non_participants(
    api_client: AsyncClient, db_session: AsyncSession
):
    spectator = await start_session(api_client, db_session)
    async with make_client() as other_client:
        await start_session(other_client, db_session)
        bystander = await make_user(db_session, "bystander")
        created = await _create_match(other_client, bystander.id)

        response = await api_client.get(f"/v1/matches/{created['id']}")
        assert response.status_code == 200
        body = response.json()
        # Spectator isn't on either side — both flags are False, and the
        # write affordance is suppressed regardless of game state.
        assert all(not s["is_current_user_side"] for s in body["sides"])
        assert all(
            not p["is_current_user"] for s in body["sides"] for p in s["players"]
        )
        assert body["can_score"] is False
        del spectator


async def test_get_unknown_match_is_404(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    response = await api_client.get(f"/v1/matches/{uuid.uuid4()}")
    assert response.status_code == 404


# ----- anonymous viewer ---------------------------------------------------


async def test_get_match_is_open_to_anonymous_callers(
    api_client: AsyncClient, db_session: AsyncSession
):
    """The match-details endpoint is open to anonymous callers: they get the
    same payload with no participant flags and can_score=False."""
    creator = await start_session(api_client, db_session)
    opponent = await make_user(db_session, "anon.viewer.opp")
    created = await _create_match(api_client, opponent.id)

    async with make_client() as client:
        response = await client.get(f"/v1/matches/{created['id']}")
    assert response.status_code == 200
    body = response.json()
    assert body["id"] == created["id"]
    # An anonymous caller never gets a session minted just by viewing.
    assert "session" not in response.cookies
    # No current user → no participant flags, no Score CTA.
    assert all(not s["is_current_user_side"] for s in body["sides"])
    assert all(not p["is_current_user"] for s in body["sides"] for p in s["players"])
    assert body["can_score"] is False
    # The underlying players still appear on the two sides.
    user_ids = {p["user_id"] for s in body["sides"] for p in s["players"]}
    assert user_ids == {str(creator.id), str(opponent.id)}


async def test_history_extras_are_gated_to_participants(
    api_client: AsyncClient, db_session: AsyncSession
):
    """Regression for #515: recent form / head-to-head / rating history is
    rivalry metadata, not part of the public scorecard. A participant viewing
    the match sees it; an anonymous holder of the share URL and a signed-in
    spectator both get the scorecard with those extras empty/null."""
    me = await start_session(api_client, db_session)
    async with opponent_session(db_session, "gated-rival") as (rival_client, rival):
        # A prior completed meeting gives both players recent form and seeds a
        # head-to-head between them.
        await _play_match_to_completion(
            api_client, rival_client, rival.id, best_of=3, side_1_wins=True
        )
        # The current match between the same two players is what we view.
        current = await _create_match(api_client, rival.id, best_of=3)

        # A participant (me) sees the rich history payload.
        mine = (await api_client.get(f"/v1/matches/{current['id']}")).json()
        assert mine["recent_form"], "participant should see recent form"
        assert mine["head_to_head"] is not None
        assert mine["head_to_head"]["total_meetings"] == 1

        # The other participant (the rival) sees it too.
        theirs = (await rival_client.get(f"/v1/matches/{current['id']}")).json()
        assert theirs["recent_form"]
        assert theirs["head_to_head"] is not None

        # A signed-in spectator who is not on either side gets the scorecard
        # only — no form, no head-to-head.
        async with make_client() as spectator_client:
            await start_session(spectator_client, db_session)
            spec = (await spectator_client.get(f"/v1/matches/{current['id']}")).json()
        assert spec["recent_form"] == []
        assert spec["head_to_head"] is None
        assert all(s["rating_change"] is None for s in spec["sides"])

        # An anonymous holder of the share URL likewise sees no history.
        async with make_client() as anon_client:
            anon = (await anon_client.get(f"/v1/matches/{current['id']}")).json()
        assert anon["recent_form"] == []
        assert anon["head_to_head"] is None
        assert all(s["rating_change"] is None for s in anon["sides"])

        # The scorecard itself is unaffected — both players still appear.
        anon_ids = {p["user_id"] for s in anon["sides"] for p in s["players"]}
        assert anon_ids == {str(me.id), str(rival.id)}


async def test_get_match_is_rate_limited_per_ip(
    api_client: AsyncClient, db_session: AsyncSession
):
    """Per-IP rate limit (60/min) protects the endpoint from being scraped
    from a single source, now that anonymous callers can hit it."""
    await start_session(api_client, db_session)
    opponent = await make_user(db_session, "rl.match.opp")
    created = await _create_match(api_client, opponent.id)

    async with make_client() as client:
        for i in range(60):
            response = await client.get(f"/v1/matches/{created['id']}")
            assert response.status_code == 200, (i, response.text)
        over = await client.get(f"/v1/matches/{created['id']}")
    assert over.status_code == 429


# ----- list ---------------------------------------------------------------


async def test_list_matches_empty(api_client: AsyncClient, db_session: AsyncSession):
    await start_session(api_client, db_session)
    response = await api_client.get("/v1/matches")
    assert response.status_code == 200
    body = response.json()
    assert body["items"] == []
    assert body["total"] == 0
    assert body["page"] == 1
    assert body["page_size"] == 25
    assert body["status_counts"]["pending"] == 0
    assert body["status_counts"]["completed"] == 0


async def test_list_matches_shows_every_match_on_the_system(
    api_client: AsyncClient, db_session: AsyncSession
):
    me = await start_session(api_client, db_session)
    async with make_client() as other_client:
        them = await start_session(other_client, db_session)
        bystander = await make_user(db_session, "bystander")
        # A match between two strangers — historically hidden, now visible.
        other_match = await _create_match(other_client, bystander.id)

    response = await api_client.get("/v1/matches")
    body = response.json()
    ids = {row["id"] for row in body["items"]}
    assert other_match["id"] in ids
    # The spectator sees both sides flagged neutrally — neither claims to be
    # `is_current_user_side`, and `me` doesn't appear in any row's players.
    row = next(r for r in body["items"] if r["id"] == other_match["id"])
    assert [side["is_current_user_side"] for side in row["sides"]] == [
        False,
        False,
    ]
    usernames = {p["username"] for side in row["sides"] for p in side["players"]}
    assert usernames == {them.username, bystander.username}
    assert me.username not in usernames


async def test_list_rows_carry_affects_rating(
    api_client: AsyncClient, db_session: AsyncSession
):
    # The list row exposes the authoritative rated flag so a client can label
    # rated vs. friendly without a rating delta (#453 — iOS mislabelled
    # finalized rated matches as "Friendly" because list rows omit rating_change).
    await start_session(api_client, db_session)
    opponent = await make_user(db_session, "opponent")
    rated = await _create_match(api_client, opponent.id)
    unrated = (
        await api_client.post(
            "/v1/matches",
            json={
                "opponent_user_id": str(opponent.id),
                "best_of": 5,
                "rated": False,
            },
        )
    ).json()

    body = (await api_client.get("/v1/matches")).json()
    by_id = {row["id"]: row for row in body["items"]}
    assert by_id[rated["id"]]["affects_rating"] is True
    assert by_id[unrated["id"]]["affects_rating"] is False


async def test_list_q_filter_matches_caller_username(
    api_client: AsyncClient, db_session: AsyncSession
):
    me = await start_session(api_client, db_session)
    opp = await make_user(db_session, "rival")
    mine = await _create_match(api_client, opp.id)
    async with make_client() as other_client:
        await start_session(other_client, db_session)
        bystander = await make_user(db_session, "bystander")
        # A match the caller is not in — searching for the caller's own
        # username should not pick this up.
        unrelated = await _create_match(other_client, bystander.id)

    listing = (await api_client.get("/v1/matches", params={"q": me.username})).json()
    ids = {row["id"] for row in listing["items"]}
    assert mine["id"] in ids
    assert unrelated["id"] not in ids


async def test_list_filter_by_status(api_client: AsyncClient, db_session: AsyncSession):
    await start_session(api_client, db_session)
    async with opponent_session(db_session, "rival") as (opp_client, opp):
        in_progress = await _create_match(api_client, opp.id, best_of=1)
        # Finalize a separate match to flip it to completed — propose + accept
        # so the opposing side's acceptance lands the status transition.
        completed_match = await _create_match(api_client, opp.id, best_of=1)
        post = await api_client.post(
            f"/v1/matches/{completed_match['id']}/results",
            json={
                "games": [
                    {"game_number": 1, "side_1_points": 11, "side_2_points": 5},
                ]
            },
        )
        assert post.status_code == 201
        await accept_standing_result(opp_client, completed_match["id"])

    listing = (
        await api_client.get("/v1/matches", params={"status": "in_progress"})
    ).json()
    assert [row["id"] for row in listing["items"]] == [in_progress["id"]]
    assert listing["status_counts"]["in_progress"] == 1
    assert listing["status_counts"]["completed"] == 1


async def test_list_live_filter_excludes_awaiting_acceptance(
    api_client: AsyncClient, db_session: AsyncSession
):
    """Regression for #381: a posted-but-unconfirmed result is an in_progress
    match with a signature ("Awaiting acceptance"). It must NOT count or list
    under the Live filter — it has its own ``awaiting_acceptance`` bucket."""
    await start_session(api_client, db_session)
    async with opponent_session(db_session, "rival") as (opp_client, opp):
        live = await _create_match(api_client, opp.id, best_of=1)
        # A second match with a posted (but unconfirmed) result: status stays
        # in_progress, one signature recorded → "Awaiting acceptance".
        awaiting = await _create_match(api_client, opp.id, best_of=1)
        post = await api_client.post(
            f"/v1/matches/{awaiting['id']}/results",
            json={
                "games": [
                    {"game_number": 1, "side_1_points": 11, "side_2_points": 5},
                ]
            },
        )
        assert post.status_code == 201
        assert post.json()["status"] == "in_progress"
        assert post.json()["status_label"] == "Awaiting acceptance"

    # Live filter: only the signature-free in_progress match.
    live_listing = (
        await api_client.get("/v1/matches", params={"status": "in_progress"})
    ).json()
    assert [row["id"] for row in live_listing["items"]] == [live["id"]]
    assert live_listing["total"] == 1
    assert live_listing["status_counts"]["in_progress"] == 1
    assert live_listing["awaiting_acceptance_count"] == 1

    # Awaiting filter: only the posted-but-unconfirmed match.
    awaiting_listing = (
        await api_client.get("/v1/matches", params={"status": "awaiting_acceptance"})
    ).json()
    assert [row["id"] for row in awaiting_listing["items"]] == [awaiting["id"]]
    assert awaiting_listing["total"] == 1
    assert awaiting_listing["items"][0]["status_label"] == "Awaiting acceptance"

    # Unfiltered: both rows present, and the total counts each exactly once.
    full = (await api_client.get("/v1/matches")).json()
    assert full["total"] == 2
    assert full["status_counts"]["in_progress"] == 1
    assert full["awaiting_acceptance_count"] == 1


async def test_list_q_filter_matches_any_player_username(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    alpha = await make_user(db_session, "alphabet")
    bravo = await make_user(db_session, "bravo")
    await _create_match(api_client, alpha.id)
    await _create_match(api_client, bravo.id)

    listing = (await api_client.get("/v1/matches", params={"q": "alpha"})).json()
    assert len(listing["items"]) == 1
    players = {
        p["username"] for side in listing["items"][0]["sides"] for p in side["players"]
    }
    assert "alphabet" in players
    # status_counts honors q (one row total)
    assert sum(listing["status_counts"].values()) == 1


async def test_list_pagination(api_client: AsyncClient, db_session: AsyncSession):
    await start_session(api_client, db_session)
    opp = await make_user(db_session, "rival")
    for _ in range(3):
        await _create_match(api_client, opp.id)

    page_1 = (
        await api_client.get("/v1/matches", params={"page": 1, "page_size": 2})
    ).json()
    page_2 = (
        await api_client.get("/v1/matches", params={"page": 2, "page_size": 2})
    ).json()
    assert page_1["total"] == 3
    assert len(page_1["items"]) == 2
    assert len(page_2["items"]) == 1
    assert {row["id"] for row in page_1["items"]} & {
        row["id"] for row in page_2["items"]
    } == set()


async def test_list_row_carries_current_game_number_when_scorable(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    opp = await make_user(db_session, "rival")
    await _create_match(api_client, opp.id)

    listing = (await api_client.get("/v1/matches")).json()
    row = listing["items"][0]
    # No games scored yet, so the next un-scored game is game 1. Game rows
    # don't exist until the first POST .../scores/new, so the listing surfaces
    # the number, not an id.
    assert row["current_game_number"] == 1
    assert row["can_score"] is True


async def test_list_row_hides_scoring_affordance_from_spectators(
    api_client: AsyncClient, db_session: AsyncSession
):
    # Spectators get neither `can_score` nor `current_game_number` — the scoring
    # route 404s for them anyway, and the FE has no reason to deep-link.
    await start_session(api_client, db_session)
    async with make_client() as other_client:
        await start_session(other_client, db_session)
        bystander = await make_user(db_session, "bystander")
        created = await _create_match(other_client, bystander.id)

    listing = (await api_client.get("/v1/matches")).json()
    row = next(r for r in listing["items"] if r["id"] == created["id"])
    assert row["current_game_number"] is None
    assert row["can_score"] is False


# ----- attention filter ---------------------------------------------------


async def _post_bo1_result(
    client: AsyncClient, match_id: str, *, s1: int = 11, s2: int = 5
) -> dict:
    response = await client.post(
        f"/v1/matches/{match_id}/results",
        json={"games": [{"game_number": 1, "side_1_points": s1, "side_2_points": s2}]},
    )
    assert response.status_code == 201
    return response.json()


async def test_list_attention_ranks_review_above_score(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    async with opponent_session(db_session, "rival") as (opp_client, opp):
        # A fresh rated match I still need to score.
        scoring = await _create_match(api_client, opp.id, best_of=1)
        # A match the opponent has posted a result on — now awaiting *my* review.
        to_review = await _create_match(api_client, opp.id, best_of=1)
        await _post_bo1_result(opp_client, to_review["id"])

    listing = (await api_client.get("/v1/matches", params={"attention": "true"})).json()
    rows = listing["items"]
    # Review (priority 1) ranks above the rated score (priority 2).
    assert [row["id"] for row in rows] == [to_review["id"], scoring["id"]]
    assert [row["attention"] for row in rows] == ["review", "score"]
    assert listing["total"] == 2
    assert listing["attention_count"] == 2


async def test_list_attention_excludes_finished_and_spectated_matches(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    async with opponent_session(db_session, "rival") as (opp_client, opp):
        open_match = await _create_match(api_client, opp.id, best_of=1)
        # A finished match (propose + accept) — no longer an attention row.
        done = await _create_match(api_client, opp.id, best_of=1)
        await _post_bo1_result(api_client, done["id"])
        await accept_standing_result(opp_client, done["id"])
    # A match between two strangers — visible when browsing, never in *my*
    # attention list.
    async with make_client() as other_client:
        await start_session(other_client, db_session)
        bystander = await make_user(db_session, "bystander")
        spectated = await _create_match(other_client, bystander.id, best_of=1)

    listing = (await api_client.get("/v1/matches", params={"attention": "true"})).json()
    ids = {row["id"] for row in listing["items"]}
    assert ids == {open_match["id"]}
    assert done["id"] not in ids
    assert spectated["id"] not in ids
    assert listing["attention_count"] == 1


async def test_list_attention_count_is_present_on_other_tabs(
    api_client: AsyncClient, db_session: AsyncSession
):
    # The Attention badge must read its own count even while another tab is
    # active, so attention_count rides every response.
    await start_session(api_client, db_session)
    opp = await make_user(db_session, "rival")
    await _create_match(api_client, opp.id, best_of=1)
    await _create_match(api_client, opp.id, best_of=1)

    listing = (
        await api_client.get("/v1/matches", params={"status": "completed"})
    ).json()
    assert listing["items"] == []
    assert listing["attention_count"] == 2


async def test_list_row_attention_kind_reflects_who_must_act(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    async with opponent_session(db_session, "rival") as (opp_client, opp):
        # I proposed a result — it's waiting on the opponent's acceptance.
        waiting = await _create_match(api_client, opp.id, best_of=1)
        await _post_bo1_result(api_client, waiting["id"])
        # The opponent proposed a result — it's my turn to review/accept it.
        to_review = await _create_match(api_client, opp.id, best_of=1)
        await _post_bo1_result(opp_client, to_review["id"])

    listing = (await api_client.get("/v1/matches")).json()
    by_id = {row["id"]: row["attention"] for row in listing["items"]}
    # The side that proposed reads as passively waiting; the opposing side owes
    # a review. Both still carry their per-row attention kind on the browsing
    # list…
    assert by_id[waiting["id"]] == "waiting_opponent"
    assert by_id[to_review["id"]] == "review"
    # …but only the actionable one counts toward *my* Attention badge — the
    # match I merely posted and am waiting on is not my problem (issue #729).
    assert listing["attention_count"] == 1


async def test_attention_tab_is_viewer_relative_for_a_posted_result(
    api_client: AsyncClient, db_session: AsyncSession
):
    # The exact issue #729 scenario: on an in-progress match with a posted
    # result, the poster is merely waiting while the opponent must review. The
    # Attention tab (membership *and* badge) has to reflect whose turn it is,
    # not read identically for both participants.
    await start_session(api_client, db_session)
    async with opponent_session(db_session, "rival") as (opp_client, opp):
        posted = await _create_match(api_client, opp.id, best_of=1)
        await _post_bo1_result(api_client, posted["id"])

        # Poster: they've signed and owe nothing — the match is neither in their
        # Attention list nor counted in their badge.
        poster_view = (
            await api_client.get("/v1/matches", params={"attention": "true"})
        ).json()
        assert [row["id"] for row in poster_view["items"]] == []
        assert poster_view["attention_count"] == 0

        # Opponent: it's their turn to review — the match *is* their attention.
        opp_view = (
            await opp_client.get("/v1/matches", params={"attention": "true"})
        ).json()
        assert [row["id"] for row in opp_view["items"]] == [posted["id"]]
        assert opp_view["attention_count"] == 1


async def test_attention_tab_excludes_pending_scheduled_matches(
    api_client: AsyncClient, db_session: AsyncSession
):
    # A pending/scheduled match ("Up next") is nobody's turn yet — it's a
    # ``waiting_others`` row, so it must not inflate the Attention badge (#729).
    await start_session(api_client, db_session)
    opp = await make_user(db_session, "rival")
    scheduled = await _create_match(api_client, opp.id, best_of=1)
    # Matches are created ``in_progress``; drop this one to ``pending`` to model
    # a scheduled ("Up next") match with no scoring started.
    await db_session.execute(
        update(Match)
        .where(Match.id == uuid.UUID(scheduled["id"]))
        .values(status=MatchStatus.pending)
    )
    await db_session.commit()

    listing = (await api_client.get("/v1/matches", params={"attention": "true"})).json()
    assert scheduled["id"] not in {row["id"] for row in listing["items"]}
    assert listing["attention_count"] == 0


# ----- TT scoring rules ---------------------------------------------------


@pytest.mark.parametrize(
    "side_1,side_2,is_valid",
    [
        (11, 0, True),
        (11, 9, True),
        (12, 10, True),
        (13, 11, True),
        (11, 10, False),  # at deuce, must lead by 2
        (13, 10, False),  # past 11 only legal when both reach 10
        (12, 9, False),
        (10, 5, False),  # winner didn't reach 11
        (0, 0, False),
        (11, 11, False),
        (100, 0, False),  # caps at 99
    ],
)
async def test_table_tennis_scoring_rules(
    api_client: AsyncClient,
    db_session: AsyncSession,
    side_1: int,
    side_2: int,
    is_valid: bool,
):
    await start_session(api_client, db_session)
    opp = await make_user(db_session, "rival")
    match = await _create_match(api_client, opp.id, best_of=5)

    response = await api_client.post(
        f"/v1/matches/{match['id']}/games/1/scores/new",
        json={"side_1_points": side_1, "side_2_points": side_2},
    )
    if is_valid:
        assert response.status_code == 201
    else:
        assert response.status_code == 422


# ----- per-game score endpoints (scratchpad state) ------------------------


async def test_score_create_lazily_inserts_the_game_row(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    opp = await make_user(db_session, "rival")
    match = await _create_match(api_client, opp.id, best_of=5)

    response = await api_client.post(
        f"/v1/matches/{match['id']}/games/1/scores/new",
        json={"side_1_points": 11, "side_2_points": 4},
    )
    assert response.status_code == 201
    body = response.json()
    # Match status, side wins, and side.won are untouched by per-game writes —
    # finalization lives entirely in POST /results.
    assert body["status"] == "in_progress"
    assert [s["games_won"] for s in body["sides"]] == [1, 0]
    assert all(s["won"] is None for s in body["sides"])
    # No trailing un-scored game auto-appended: only game 1 exists.
    assert [g["game_number"] for g in body["games"]] == [1]
    assert body["games"][0]["score"]["side_1_points"] == 11
    # current_game advances to the next un-scored slot (lazy — no row yet).
    assert body["current_game"] == {"game_number": 2}
    assert body["can_score"] is True
    assert body["can_finalize"] is False

    games = (await db_session.execute(select(MatchGame))).scalars().all()
    assert len(games) == 1


async def test_score_create_409_when_game_already_scored(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    opp = await make_user(db_session, "rival")
    match = await _create_match(api_client, opp.id, best_of=5)
    await api_client.post(
        f"/v1/matches/{match['id']}/games/1/scores/new",
        json={"side_1_points": 11, "side_2_points": 4},
    )

    second = await api_client.post(
        f"/v1/matches/{match['id']}/games/1/scores/new",
        json={"side_1_points": 11, "side_2_points": 5},
    )
    assert second.status_code == 409
    # A second create is the same conflict the update path guards against — the
    # 409 carries the committed score (the first write's 11–4) so the client can
    # surface it for review rather than overwrite it.
    detail = second.json()["detail"]
    assert detail["committed_score"]["side_1_points"] == 11
    assert detail["committed_score"]["side_2_points"] == 4
    assert detail["committed_score"]["version"] == 1


async def test_concurrent_score_create_returns_409_not_500(
    api_client: AsyncClient, db_session: AsyncSession, engine: AsyncEngine
):
    """Regression for #362. Two participants sitting on the same
    game-score-entry page who submit at the same instant must both get a clean
    409, never a raw 500.

    Since ADR-0009 the score path takes the blocking match row lock, so the two
    creates *serialize*: the loser waits, re-reads the committed game under the
    lock, and 409s via the ``game.score is not None`` pre-check rather than the
    ``uq_match_games_match_id_game_number`` collision at commit. (The
    ``except IntegrityError`` handler on the create path is retained as a
    backstop for any residual same-game insert race, but the lock means this
    test exercises the pre-check path.)

    Driven on two *separate* DB sessions (real distinct Postgres connections)
    via ``asyncio.gather`` — the shared ``db_session`` override can't surface
    the race. An un-mapped exception would escape ``run``'s
    ``HTTPException``-only ``except`` and fail the test loudly, which is exactly
    the 500 we're guarding against.
    """
    me = await start_session(api_client, db_session)
    async with opponent_session(db_session, "race-opp") as (_opp_client, opp):
        # A fresh rated match: both participants may score game 1, and the
        # game row doesn't exist yet, so each request inserts it.
        match = await _create_match(api_client, opp.id, best_of=5)
        match_id = uuid.UUID(match["id"])
        me_id, opp_id = me.id, opp.id

        make_session = async_sessionmaker(engine, expire_on_commit=False)

        async def run(user_id: uuid.UUID, side_1: int, side_2: int) -> object:
            async with make_session() as session:
                user = (
                    await session.execute(select(User).where(User.id == user_id))
                ).scalar_one()
                payload = MatchGameScoreWrite(
                    side_1_points=side_1, side_2_points=side_2
                )
                try:
                    await create_game_score(
                        match_id, payload, 1, user, session, _match_service(session)
                    )
                    return "ok"
                except HTTPException as exc:
                    return exc.status_code

        outcomes = await asyncio.gather(run(me_id, 11, 9), run(opp_id, 5, 11))

        # Exactly one write wins; the other is cleanly rejected with 409,
        # never a 500 and never a second silent success.
        assert sorted(str(o) for o in outcomes) == ["409", "ok"], outcomes
        assert all(o != 500 for o in outcomes), outcomes

        # The committed match holds exactly one score for game 1.
        async with make_session() as verify:
            scores = (
                (
                    await verify.execute(
                        select(MatchGameScore)
                        .join(MatchGame, MatchGameScore.match_game_id == MatchGame.id)
                        .where(MatchGame.match_id == match_id)
                    )
                )
                .scalars()
                .all()
            )
            assert len(scores) == 1, scores


def _install_scoring_load_barrier(
    monkeypatch: pytest.MonkeyPatch,
) -> tuple[asyncio.Event, asyncio.Event]:
    """Barrier on the ``_load_match_for_scoring`` seam for a deterministic
    first-propose race. The score path (which never passes ``nowait``) parks
    after loading until ``settled`` is set; the propose (``nowait=True``) sails
    through. Returns ``(loaded, settled)`` — the score racer sets ``loaded`` once
    it has loaded, the propose sets ``settled`` once it has run, pinning
    "scorer loads → proposer settles → scorer commits"."""
    loaded = asyncio.Event()
    settled = asyncio.Event()
    real_loader = matches_mod._load_match_for_scoring

    async def loader_with_barrier(
        db: AsyncSession,
        target_id: uuid.UUID,
        current_user_id: uuid.UUID,
        *,
        lock: bool = False,
        nowait: bool = False,
        options: tuple[ExecutableOption, ...] | None = None,
    ) -> Match:
        result = await real_loader(
            db,
            target_id,
            current_user_id,
            lock=lock,
            nowait=nowait,
            options=options,
        )
        if not nowait:
            loaded.set()
            await settled.wait()
        return result

    monkeypatch.setattr(matches_mod, "_load_match_for_scoring", loader_with_barrier)
    return loaded, settled


async def _first_propose_after_barrier(
    make_session: async_sessionmaker[AsyncSession],
    loaded: asyncio.Event,
    settled: asyncio.Event,
    match_id: uuid.UUID,
    user_id: uuid.UUID,
    games: list[MatchResultsGameWrite],
) -> int:
    """The proposer half of a barriered first-propose race (see
    ``_install_scoring_load_barrier``): wait for the score racer to load, then
    post a first result directly on its own real session, signalling ``settled``
    when done so the parked racer can resume. Returns the result status."""
    await loaded.wait()
    async with make_session() as session:
        user = (
            await session.execute(select(User).where(User.id == user_id))
        ).scalar_one()
        try:
            await post_match_result(
                match_id,
                MatchResultsWrite(games=games),
                user,
                session,
                _match_service(session),
                NotificationService(session, FakeSender()),
            )
            return 201
        except HTTPException as exc:
            return exc.status_code
        finally:
            settled.set()


async def test_create_game_score_racing_first_propose_never_strays(
    api_client: AsyncClient,
    db_session: AsyncSession,
    engine: AsyncEngine,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Regression for #835. A per-game score write must not commit *atop* a
    result the concurrent first-propose already froze.

    Before the fix the three score endpoints loaded the match *without* the row
    lock and enforced ``_is_scorable`` on that lock-free snapshot. A scorer that
    loaded before the freeze could commit after it — stranding a scratchpad game
    on top of a minted result the frozen board never described.

    Deterministic interleave via a barrier on the ``_load_match_for_scoring``
    seam: the score path (no ``nowait``) parks after loading until the proposer
    (which passes ``nowait=True``) has run to completion, pinning "scorer loads
    → proposer settles → scorer commits".

    Post-fix the scorer takes the *blocking* row lock on its load, so the
    concurrent first-propose (which locks ``NOWAIT``) bounces with a 409, and
    the scorer's own ``_enforce_scorable`` recheck runs under the lock on still
    -unfrozen state: the write lands as a plain scratchpad edit (board
    ``[1, 2, 5]``, no result) rather than a stray game atop a frozen result.

    Pre-fix this is RED: both sides return ``(201, 201)`` and the committed match
    carries a stray game 5 on top of a posted result.
    """
    me = await start_session(api_client, db_session)
    async with opponent_session(db_session, "race-opp") as (_opp_client, opp):
        match = await _create_match(api_client, opp.id, best_of=5)
        match_id = uuid.UUID(match["id"])
        me_id = me.id

        # Seed the shared scratchpad at 1-1 (game 1 to side 1, game 2 to side 2)
        # BEFORE installing the barrier, so both racers see the same pre-image.
        await api_client.post(
            f"/v1/matches/{match['id']}/games/1/scores/new",
            json={"side_1_points": 11, "side_2_points": 2},
        )
        await api_client.post(
            f"/v1/matches/{match['id']}/games/2/scores/new",
            json={"side_1_points": 2, "side_2_points": 11},
        )

        make_session = async_sessionmaker(engine, expire_on_commit=False)
        loaded, settled = _install_scoring_load_barrier(monkeypatch)

        async def scorer() -> int:
            async with make_session() as session:
                user = (
                    await session.execute(select(User).where(User.id == me_id))
                ).scalar_one()
                payload = MatchGameScoreWrite(side_1_points=11, side_2_points=2)
                try:
                    await create_game_score(
                        match_id, payload, 5, user, session, _match_service(session)
                    )
                    return 201
                except HTTPException as exc:
                    return exc.status_code

        # First-propose board: decided 3-1, clinch at game 4, games 1&2 match the
        # scratchpad.
        scorer_status, proposer_status = await asyncio.gather(
            scorer(),
            _first_propose_after_barrier(
                make_session,
                loaded,
                settled,
                match_id,
                me_id,
                [_game(1, 11, 2), _game(2, 2, 11), _game(3, 11, 2), _game(4, 11, 2)],
            ),
        )

        # The scorer holds the lock; the concurrent first-propose (NOWAIT) bounces.
        assert scorer_status == 201, scorer_status
        assert proposer_status == 409, proposer_status

        async with make_session() as verify:
            final = (
                await verify.execute(
                    select(Match)
                    .where(Match.id == match_id)
                    .options(
                        selectinload(Match.results),
                        selectinload(Match.games),
                    )
                )
            ).scalar_one()
            # No result was minted, and the board is a still-editable scratchpad —
            # the #835 stray-atop-a-frozen-result is unreachable.
            assert final.results == []
            assert sorted(g.game_number for g in final.games) == [1, 2, 5]


async def test_delete_game_score_double_clear_never_500s(
    api_client: AsyncClient, db_session: AsyncSession, engine: AsyncEngine
) -> None:
    """Audit finding #8. Two participants clearing the same game's score at once
    must serialize to one 200 (cleared) + one 404 (already gone), never a raw
    error or a lying double-200.

    Pre-fix both loads are lock-free, so both find the score, both null it, and
    both commit — the loser's ``delete-orphan`` DELETE matches zero rows and only
    emits a benign ``SAWarning`` (the models carry no ``version_id_col``, so it
    does *not* raise ``StaleDataError``). That yields ``[200, 200]`` — a lying
    success. The blocking lock makes the loser re-read the now-empty game and
    return a truthful 404 instead.
    """
    me = await start_session(api_client, db_session)
    async with opponent_session(db_session, "race-opp") as (_opp_client, opp):
        match = await _create_match(api_client, opp.id, best_of=5)
        match_id = uuid.UUID(match["id"])
        me_id = me.id

        await api_client.post(
            f"/v1/matches/{match['id']}/games/3/scores/new",
            json={"side_1_points": 11, "side_2_points": 5},
        )

        make_session = async_sessionmaker(engine, expire_on_commit=False)

        async def run() -> object:
            async with make_session() as session:
                user = (
                    await session.execute(select(User).where(User.id == me_id))
                ).scalar_one()
                try:
                    await delete_game_score(
                        match_id, 3, user, session, _match_service(session)
                    )
                    return 200
                except HTTPException as exc:
                    return exc.status_code

        outcomes = await asyncio.gather(run(), run())

        # One truthful clear, one truthful "already gone" — never a 500, never a
        # raw exception, never a double-200.
        assert all(isinstance(o, int) for o in outcomes), outcomes
        assert all(o != 500 for o in outcomes), outcomes
        assert sorted(outcomes) == [200, 404], outcomes

        async with make_session() as verify:
            scores = (
                (
                    await verify.execute(
                        select(MatchGameScore)
                        .join(MatchGame, MatchGameScore.match_game_id == MatchGame.id)
                        .where(MatchGame.match_id == match_id)
                    )
                )
                .scalars()
                .all()
            )
            assert scores == [], scores


async def test_update_game_score_racing_first_propose_never_500s(
    api_client: AsyncClient,
    db_session: AsyncSession,
    engine: AsyncEngine,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A conditional update whose target score row a concurrent first-propose
    deletes (via ``_commit_canonical_games``'s clear/reinsert) must not 500 on
    the ``db.refresh(game.score)`` of a since-deleted row — that refresh is the
    one genuine-500 candidate on the score path.

    Same barrier technique as the #835 create test: the updater parks after its
    lock-free load, the first-propose freezes the board (deleting the score row
    the update targets), then the updater proceeds.

    Pre-fix the update loads without the lock, so the propose freezes underneath
    it: the conditional UPDATE matches zero rows (its target id was deleted) and
    ``db.refresh`` is called on that deleted row — a raw
    ``sqlalchemy.exc.InvalidRequestError`` (an uncaught 500), not an
    ``HTTPException``, so it escapes the handler entirely.

    Post-fix the updater takes the *blocking* lock first, so the first-propose
    (NOWAIT) bounces with a 409 and the update runs under the lock against
    still-unfrozen state — its target row still exists at version 1, so the
    conditional UPDATE matches and it returns a clean 200. The proposer 409s.
    """
    me = await start_session(api_client, db_session)
    async with opponent_session(db_session, "race-opp") as (_opp_client, opp):
        match = await _create_match(api_client, opp.id, best_of=5)
        match_id = uuid.UUID(match["id"])
        me_id = me.id

        # Seed games 1 & 2 so the propose board's first two games match the
        # scratchpad; the update targets game 1 (version 1).
        await api_client.post(
            f"/v1/matches/{match['id']}/games/1/scores/new",
            json={"side_1_points": 11, "side_2_points": 9},
        )
        await api_client.post(
            f"/v1/matches/{match['id']}/games/2/scores/new",
            json={"side_1_points": 2, "side_2_points": 11},
        )

        make_session = async_sessionmaker(engine, expire_on_commit=False)
        loaded, settled = _install_scoring_load_barrier(monkeypatch)

        async def updater() -> int:
            async with make_session() as session:
                user = (
                    await session.execute(select(User).where(User.id == me_id))
                ).scalar_one()
                payload = MatchGameScoreUpdate(
                    side_1_points=8, side_2_points=11, expected_version=1
                )
                try:
                    await update_game_score(
                        match_id, payload, 1, user, session, _match_service(session)
                    )
                    return 200
                except HTTPException as exc:
                    return exc.status_code

        updater_status, proposer_status = await asyncio.gather(
            updater(),
            _first_propose_after_barrier(
                make_session,
                loaded,
                settled,
                match_id,
                me_id,
                [_game(1, 11, 9), _game(2, 2, 11), _game(3, 11, 2), _game(4, 11, 2)],
            ),
        )

        # Clean serialized outcome: the updater holds the lock, the first-propose
        # (NOWAIT) is bounced, and the update runs under the lock against its
        # still-unfrozen target row (version 1) — a deterministic 200, never a
        # raw StaleDataError/InvalidRequestError.
        assert updater_status == 200, updater_status
        assert proposer_status == 409, proposer_status


async def test_score_create_422_when_game_number_exceeds_best_of(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    opp = await make_user(db_session, "rival")
    match = await _create_match(api_client, opp.id, best_of=3)

    response = await api_client.post(
        f"/v1/matches/{match['id']}/games/4/scores/new",
        json={"side_1_points": 11, "side_2_points": 4},
    )
    assert response.status_code == 422
    assert "best of 3" in response.json()["detail"]


async def test_score_create_accepts_gaps(
    api_client: AsyncClient, db_session: AsyncSession
):
    # The per-game endpoints are pure scratchpad — gaps are fine. Contiguity
    # is enforced only when finalizing via POST /results.
    await start_session(api_client, db_session)
    opp = await make_user(db_session, "rival")
    match = await _create_match(api_client, opp.id, best_of=5)

    # Score game 3 before game 1 or 2 — the FE can let users enter games in
    # any order.
    response = await api_client.post(
        f"/v1/matches/{match['id']}/games/3/scores/new",
        json={"side_1_points": 11, "side_2_points": 9},
    )
    assert response.status_code == 201
    body = response.json()
    assert [g["game_number"] for g in body["games"]] == [3]
    # current_game falls back to the lowest unscored slot — game 1.
    assert body["current_game"] == {"game_number": 1}
    assert body["can_finalize"] is False


async def _sweep_games(
    api_client: AsyncClient, match_id: str, game_numbers: list[int]
) -> None:
    """Save a side-1 win (11-2) for each given game number, asserting 201."""
    for n in game_numbers:
        response = await api_client.post(
            f"/v1/matches/{match_id}/games/{n}/scores/new",
            json={"side_1_points": 11, "side_2_points": 2},
        )
        assert response.status_code == 201, response.json()


async def test_score_create_422_when_board_already_decided(
    api_client: AsyncClient, db_session: AsyncSession
):
    # First-to-4 (best of 7): once side 1 sweeps games 1-4 the match is decided,
    # so game 5 can never be played. The scratchpad must reject the write — even
    # though games 1-4 alone (decider == last == 4) are a perfectly valid board.
    await start_session(api_client, db_session)
    opp = await make_user(db_session, "rival")
    match = await _create_match(api_client, opp.id, best_of=7)

    await _sweep_games(api_client, match["id"], [1, 2, 3, 4])

    response = await api_client.post(
        f"/v1/matches/{match['id']}/games/5/scores/new",
        json={"side_1_points": 11, "side_2_points": 2},
    )
    assert response.status_code == 422
    assert "already decided at game 4" in response.json()["detail"]


async def test_score_create_422_on_full_sweep_out_of_order(
    api_client: AsyncClient, db_session: AsyncSession
):
    # The literal bug report: building a 7-0 board by entering games out of
    # order. With games 1-4 swept, a direct write to game 7 is rejected — you
    # can't play a game after the match was already won.
    await start_session(api_client, db_session)
    opp = await make_user(db_session, "rival")
    match = await _create_match(api_client, opp.id, best_of=7)

    await _sweep_games(api_client, match["id"], [1, 2, 3, 4])

    response = await api_client.post(
        f"/v1/matches/{match['id']}/games/7/scores/new",
        json={"side_1_points": 11, "side_2_points": 2},
    )
    assert response.status_code == 422
    assert "already decided at game 4" in response.json()["detail"]


async def test_4_3_board_to_game_7_is_valid_and_finalizes(
    api_client: AsyncClient, db_session: AsyncSession
):
    # A best-of-7 that goes the distance: 3-3 after six games, side 1 clinches
    # game 7. The decider is the last game, so every save lands and the full
    # seven-game board finalizes — proving the guard doesn't kill a legitimate
    # 4-3 result.
    await start_session(api_client, db_session)
    opp = await make_user(db_session, "rival")
    match = await _create_match(api_client, opp.id, best_of=7)

    # side 1 wins odd games, side 2 wins even games → 3-3 after game 6.
    for n in range(1, 7):
        side1, side2 = (11, 2) if n % 2 == 1 else (2, 11)
        response = await api_client.post(
            f"/v1/matches/{match['id']}/games/{n}/scores/new",
            json={"side_1_points": side1, "side_2_points": side2},
        )
        assert response.status_code == 201, response.json()

    after_g7 = await api_client.post(
        f"/v1/matches/{match['id']}/games/7/scores/new",
        json={"side_1_points": 11, "side_2_points": 2},
    )
    assert after_g7.status_code == 201
    assert after_g7.json()["can_finalize"] is True

    finalize = await api_client.post(
        f"/v1/matches/{match['id']}/results",
        json={
            "games": [
                {
                    "game_number": n,
                    "side_1_points": 11 if (n % 2 == 1 or n == 7) else 2,
                    "side_2_points": 2 if (n % 2 == 1 or n == 7) else 11,
                }
                for n in range(1, 8)
            ]
        },
    )
    assert finalize.status_code == 201, finalize.json()


async def test_legit_4_1_board_still_finalizes(
    api_client: AsyncClient, db_session: AsyncSession
):
    # A 4-1 best-of-7 (decider at game 5) — guards against over-rejecting a
    # normal short board where the decider is the highest scored game.
    await start_session(api_client, db_session)
    opp = await make_user(db_session, "rival")
    match = await _create_match(api_client, opp.id, best_of=7)

    # side 2 takes game 4; side 1 wins 1,2,3,5 → clinches at game 5.
    for n, (side1, side2) in enumerate(
        [(11, 2), (11, 2), (11, 2), (2, 11), (11, 2)], start=1
    ):
        response = await api_client.post(
            f"/v1/matches/{match['id']}/games/{n}/scores/new",
            json={"side_1_points": side1, "side_2_points": side2},
        )
        assert response.status_code == 201, response.json()

    body = (await api_client.get(f"/v1/matches/{match['id']}")).json()
    assert body["can_finalize"] is True


async def test_score_update_422_when_edit_creates_overrun(
    api_client: AsyncClient, db_session: AsyncSession
):
    # Editing an existing game's winner can move the decider earlier. Start from
    # a valid board where side 2 took game 4 (so side 1 clinches at game 5);
    # flipping game 4 to a side-1 win makes side 1 reach 4 wins at game 4 while
    # game 5 is still scored → overrun → 422.
    await start_session(api_client, db_session)
    opp = await make_user(db_session, "rival")
    match = await _create_match(api_client, opp.id, best_of=7)

    for n, (side1, side2) in enumerate(
        [(11, 2), (11, 2), (11, 2), (2, 11), (11, 2)], start=1
    ):
        response = await api_client.post(
            f"/v1/matches/{match['id']}/games/{n}/scores/new",
            json={"side_1_points": side1, "side_2_points": side2},
        )
        assert response.status_code == 201, response.json()

    edit = await api_client.put(
        f"/v1/matches/{match['id']}/games/4/scores",
        json={"side_1_points": 11, "side_2_points": 2, "expected_version": 1},
    )
    assert edit.status_code == 422
    assert "already decided at game 4" in edit.json()["detail"]


async def test_score_update_422_on_overrun_when_board_has_a_gap(
    api_client: AsyncClient, db_session: AsyncSession
):
    # The overrun guard must operate on the RAW (gappy) board, not a compacted
    # one — otherwise the edited game's raw ``game_number`` no longer aligns with
    # the renumbered slots and the substitution lands on the wrong game, silently
    # bypassing the guard. Board: side 1 takes games 1-3, side 2 takes games 5-6,
    # game 4 left blank (a legal, undecided gappy scratchpad). Flipping game 5 to
    # a side-1 win clinches side 1 at game 5 while game 6 is still scored →
    # overrun → 422.
    await start_session(api_client, db_session)
    opp = await make_user(db_session, "rival")
    match = await _create_match(api_client, opp.id, best_of=7)

    for n, (side1, side2) in [
        (1, (11, 2)),
        (2, (11, 2)),
        (3, (11, 2)),
        (5, (2, 11)),
        (6, (2, 11)),
    ]:
        response = await api_client.post(
            f"/v1/matches/{match['id']}/games/{n}/scores/new",
            json={"side_1_points": side1, "side_2_points": side2},
        )
        assert response.status_code == 201, response.json()

    edit = await api_client.put(
        f"/v1/matches/{match['id']}/games/5/scores",
        json={"side_1_points": 11, "side_2_points": 2, "expected_version": 1},
    )
    assert edit.status_code == 422, edit.json()
    assert "already decided at game 5" in edit.json()["detail"]


async def test_score_update_overwrites_in_place(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    opp = await make_user(db_session, "rival")
    match = await _create_match(api_client, opp.id, best_of=5)
    await api_client.post(
        f"/v1/matches/{match['id']}/games/1/scores/new",
        json={"side_1_points": 11, "side_2_points": 4},
    )

    edited = await api_client.put(
        f"/v1/matches/{match['id']}/games/1/scores",
        json={"side_1_points": 5, "side_2_points": 11, "expected_version": 1},
    )
    assert edited.status_code == 200
    body = edited.json()
    # Side wins flip, but status / won / current_game stay untouched —
    # nothing about the match is finalized just because a score changed.
    assert [s["games_won"] for s in body["sides"]] == [0, 1]
    assert body["status"] == "in_progress"
    assert all(s["won"] is None for s in body["sides"])
    assert body["current_game"] == {"game_number": 2}
    # No new game row was created.
    assert [g["game_number"] for g in body["games"]] == [1]


async def test_score_update_404_when_no_saved_score(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    opp = await make_user(db_session, "rival")
    match = await _create_match(api_client, opp.id, best_of=5)

    response = await api_client.put(
        f"/v1/matches/{match['id']}/games/1/scores",
        json={"side_1_points": 11, "side_2_points": 5, "expected_version": 1},
    )
    assert response.status_code == 404
    assert response.json()["detail"] == "Score not found."


async def test_score_update_409_on_stale_version(
    api_client: AsyncClient, db_session: AsyncSession
):
    """Regression for concurrent score-entry data loss. Two participants both
    sit on game 1's edit page at version 1. One saves (bumping to version 2);
    the other's save still claims version 1, so the conditional PUT must reject
    it with a 409 carrying the committed score — never silently overwrite the
    first writer's result, the last-write-wins bug this guard exists to kill."""
    await start_session(api_client, db_session)
    async with opponent_session(db_session, "rival") as (opp_client, opp):
        match = await _create_match(api_client, opp.id, best_of=5)
        # Game 1 first scored — both participants now hold version 1.
        created = (
            await api_client.post(
                f"/v1/matches/{match['id']}/games/1/scores/new",
                json={"side_1_points": 11, "side_2_points": 9},
            )
        ).json()
        assert created["games"][0]["score"]["version"] == 1

        # The opponent commits their correction first: 11–5 bumps v1 → v2.
        first = await opp_client.put(
            f"/v1/matches/{match['id']}/games/1/scores",
            json={"side_1_points": 11, "side_2_points": 5, "expected_version": 1},
        )
        assert first.status_code == 200
        assert first.json()["games"][0]["score"]["version"] == 2

        # The stale writer still claims version 1: rejected, never applied.
        stale = await api_client.put(
            f"/v1/matches/{match['id']}/games/1/scores",
            json={"side_1_points": 11, "side_2_points": 7, "expected_version": 1},
        )
        assert stale.status_code == 409
        detail = stale.json()["detail"]
        assert detail["committed_score"]["side_1_points"] == 11
        assert detail["committed_score"]["side_2_points"] == 5
        assert detail["committed_score"]["version"] == 2

        # The committed score is exactly the opponent's — the stale 11–7 write
        # left no trace.
        db_session.expire_all()
        scores = (await db_session.execute(select(MatchGameScore))).scalars().all()
        assert len(scores) == 1
        assert (scores[0].side_1_points, scores[0].side_2_points) == (11, 5)
        assert scores[0].version == 2


async def test_score_delete_clears_the_score_and_keeps_the_game(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    opp = await make_user(db_session, "rival")
    match = await _create_match(api_client, opp.id, best_of=5)
    await api_client.post(
        f"/v1/matches/{match['id']}/games/1/scores/new",
        json={"side_1_points": 11, "side_2_points": 4},
    )

    cleared = await api_client.delete(f"/v1/matches/{match['id']}/games/1/scores")
    assert cleared.status_code == 200
    body = cleared.json()
    assert [s["games_won"] for s in body["sides"]] == [0, 0]
    assert body["current_game"] == {"game_number": 1}

    # A fresh POST .../scores/new at the same game number succeeds — the
    # game row stays in place, just with no score attached.
    again = await api_client.post(
        f"/v1/matches/{match['id']}/games/1/scores/new",
        json={"side_1_points": 11, "side_2_points": 9},
    )
    assert again.status_code == 201

    scores = (await db_session.execute(select(MatchGameScore))).scalars().all()
    assert len(scores) == 1
    assert scores[0].side_2_points == 9


async def test_score_delete_404_when_no_saved_score(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    opp = await make_user(db_session, "rival")
    match = await _create_match(api_client, opp.id, best_of=5)

    response = await api_client.delete(f"/v1/matches/{match['id']}/games/2/scores")
    assert response.status_code == 404


async def test_logged_out_cannot_score(
    api_client: AsyncClient, db_session: AsyncSession
):
    # Auth is enforced before participant/existence checks: a real, valid match
    # (seeded by a genuinely authenticated client) still 401s a cookieless caller.
    async with make_client() as owner_client:
        owner = await start_session(owner_client, db_session)
        opp = await make_user(db_session, "rival")
        del owner
        match = await _create_match(owner_client, opp.id, best_of=5)

    # ``api_client`` never called ``/v1/session``, so it carries no session cookie.
    post = await api_client.post(
        f"/v1/matches/{match['id']}/games/1/scores/new",
        json={"side_1_points": 11, "side_2_points": 4},
    )
    assert post.status_code == 401
    put = await api_client.put(
        f"/v1/matches/{match['id']}/games/1/scores",
        json={"side_1_points": 11, "side_2_points": 4, "expected_version": 1},
    )
    assert put.status_code == 401


async def test_non_participant_cannot_score(
    api_client: AsyncClient, db_session: AsyncSession
):
    # 404 (not 403) — non-participants don't get to learn that the match
    # exists from a write path.
    await start_session(api_client, db_session)
    async with make_client() as other_client:
        them = await start_session(other_client, db_session)
        bystander = await make_user(db_session, "bystander")
        created = await _create_match(other_client, bystander.id)
        del them

        post = await api_client.post(
            f"/v1/matches/{created['id']}/games/1/scores/new",
            json={"side_1_points": 11, "side_2_points": 4},
        )
        assert post.status_code == 404
        put = await api_client.put(
            f"/v1/matches/{created['id']}/games/1/scores",
            json={"side_1_points": 11, "side_2_points": 4, "expected_version": 1},
        )
        assert put.status_code == 404
        delete = await api_client.delete(f"/v1/matches/{created['id']}/games/1/scores")
        assert delete.status_code == 404
        results = await api_client.post(
            f"/v1/matches/{created['id']}/results",
            json={
                "games": [
                    {"game_number": 1, "side_1_points": 11, "side_2_points": 4},
                    {"game_number": 2, "side_1_points": 11, "side_2_points": 7},
                ]
            },
        )
        assert results.status_code == 404


async def test_can_score_match_without_opponent(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    created = (
        await api_client.post("/v1/matches", json={"best_of": 5, "rated": False})
    ).json()
    response = await api_client.post(
        f"/v1/matches/{created['id']}/games/1/scores/new",
        json={"side_1_points": 11, "side_2_points": 4},
    )
    # The sentinel opponent side makes the match scorable.
    assert response.status_code == 201
    body = response.json()
    sides = sorted(body["sides"], key=lambda s: s["side_number"])
    assert [s["games_won"] for s in sides] == [1, 0]


# ----- finalize (POST /v1/matches/{id}/results) ---------------------------


async def test_propose_commits_canon_and_leaves_result_standing(
    api_client: AsyncClient, db_session: AsyncSession
):
    """``POST /results`` (propose) on a rated match commits the canonical games
    (obliterating the scratchpad) and mints a standing result — but leaves
    status at ``in_progress`` and ``side.won`` unset until the opposing side
    accepts. The negotiation block reads ``awaiting`` for the proposer."""
    me = await start_session(api_client, db_session)
    async with opponent_session(db_session, "rival") as (opp_client, opp):
        match = await _create_match(api_client, opp.id, best_of=3)

        # Pre-propose, the FE has scratched game 1 into the shared scratchpad;
        # the /results payload posts a board built from it (adding game 2).
        # Propose obliterates the scratchpad and reinserts from the payload —
        # no board-level divergence guard runs (ADR-0005, #825).
        await api_client.post(
            f"/v1/matches/{match['id']}/games/1/scores/new",
            json={"side_1_points": 11, "side_2_points": 4},
        )

        response = await api_client.post(
            f"/v1/matches/{match['id']}/results",
            json={
                "games": [
                    {"game_number": 1, "side_1_points": 11, "side_2_points": 4},
                    {"game_number": 2, "side_1_points": 11, "side_2_points": 7},
                ]
            },
        )
        assert response.status_code == 201
        body = response.json()
        # Status holds at in_progress with the awaiting-confirmation label —
        # the proposal is on the table, the other side hasn't accepted.
        assert body["status"] == "in_progress"
        assert body["status_label"] == "Awaiting acceptance"
        assert body["can_score"] is False
        assert body["can_finalize"] is False
        # The proposer's negotiation view: their own side proposed, so it's the
        # opponent's move — ``awaiting``, never their turn, no diff.
        neg = body["negotiation"]
        assert neg["viewer_state"] == "awaiting"
        assert neg["your_turn"] is False
        assert neg["prior_result"] is None
        assert neg["diff"] is None
        assert neg["standing_result"]["submitted_by"] == str(me.id)
        sides = sorted(body["sides"], key=lambda s: s["side_number"])
        # side.won is NOT set on propose for a rated match — the opponent hasn't
        # ratified the claim yet; acceptance stamps it (#485).
        assert [s["won"] for s in sides] == [None, None]
        # Games + scores reflect the payload, not the scratchpad.
        games = sorted(body["games"], key=lambda g: g["game_number"])
        assert [g["game_number"] for g in games] == [1, 2]
        assert games[0]["score"]["side_1_points"] == 11
        assert games[0]["score"]["side_2_points"] == 4

        # DB-side sanity: no orphan score rows from the obliterated scratchpad.
        game_rows = (await db_session.execute(select(MatchGame))).scalars().all()
        score_rows = (await db_session.execute(select(MatchGameScore))).scalars().all()
        assert len(game_rows) == 2
        assert len(score_rows) == 2

        # Exactly one result row exists, unaccepted (standing).
        results = (await db_session.execute(select(MatchResult))).scalars().all()
        assert len(results) == 1
        assert results[0].accepted_by_user_id is None
        assert results[0].supersedes_result_id is None


async def test_details_negotiation_carries_retirement_deadline(
    api_client: AsyncClient, db_session: AsyncSession
):
    """A rated match with a standing (unaccepted) result exposes the absolute
    retirement deadline on its negotiation block — the standing result's
    ``submitted_at`` plus the settings' default seven-day window."""
    await start_session(api_client, db_session)
    async with opponent_session(db_session, "rival") as (opp_client, opp):
        match = await _create_match(api_client, opp.id, best_of=1)
        await _post_bo1_result(opp_client, match["id"])

        neg = (await api_client.get(f"/v1/matches/{match['id']}")).json()["negotiation"]

    submitted_at = datetime.fromisoformat(neg["standing_result"]["submitted_at"])
    deadline = datetime.fromisoformat(neg["retirement_deadline"])
    assert deadline == submitted_at + timedelta(days=7)


async def test_details_negotiation_retirement_deadline_none_when_window_null(
    api_client: AsyncClient, db_session: AsyncSession
):
    """A standing result whose settings carry no retirement window (NULL) never
    auto-finalizes, so the deadline is ``None`` even though a result stands."""
    await start_session(api_client, db_session)
    async with opponent_session(db_session, "rival") as (opp_client, opp):
        match = await _create_match(api_client, opp.id, best_of=1)
        await _post_bo1_result(opp_client, match["id"])

        settings = (
            await db_session.execute(
                select(MatchSettings)
                .join(Match, Match.match_settings_id == MatchSettings.id)
                .where(Match.id == uuid.UUID(match["id"]))
            )
        ).scalar_one()
        settings.retirement_window = None
        await db_session.commit()

        neg = (await api_client.get(f"/v1/matches/{match['id']}")).json()["negotiation"]

    assert neg["standing_result"] is not None
    assert neg["retirement_deadline"] is None


async def test_details_negotiation_retirement_deadline_none_when_accepted(
    api_client: AsyncClient, db_session: AsyncSession
):
    """Once a result is accepted the head is no longer *standing*, so there is
    nothing to retire — the deadline is ``None`` on the ``final`` block."""
    await start_session(api_client, db_session)
    async with opponent_session(db_session, "rival") as (opp_client, opp):
        match = await _create_match(api_client, opp.id, best_of=1)
        await _post_bo1_result(api_client, match["id"])
        await accept_standing_result(opp_client, match["id"])

        neg = (await api_client.get(f"/v1/matches/{match['id']}")).json()["negotiation"]

    assert neg["viewer_state"] == "final"
    assert neg["retirement_deadline"] is None


async def test_list_row_negotiation_carries_retirement_deadline(
    api_client: AsyncClient, db_session: AsyncSession
):
    """The match-list row's negotiation block carries the same absolute
    retirement deadline as match detail (both embed ``MatchNegotiation``)."""
    await start_session(api_client, db_session)
    async with opponent_session(db_session, "rival") as (opp_client, opp):
        match = await _create_match(api_client, opp.id, best_of=1)
        await _post_bo1_result(opp_client, match["id"])

    listing = (await api_client.get("/v1/matches", params={"attention": "true"})).json()
    row = next(r for r in listing["items"] if r["id"] == match["id"])
    neg = row["negotiation"]

    submitted_at = datetime.fromisoformat(neg["standing_result"]["submitted_at"])
    deadline = datetime.fromisoformat(neg["retirement_deadline"])
    assert deadline == submitted_at + timedelta(days=7)


async def test_propose_first_post_requires_no_existing_result(
    api_client: AsyncClient, db_session: AsyncSession
):
    """A first proposal (``supersedes_result_id`` omitted) requires that no
    result exists yet. A second first-post on the same match bounces 409 with
    the moved-on negotiation state — the caller should counter (supersede) or
    accept instead."""
    await start_session(api_client, db_session)
    async with opponent_session(db_session, "rival") as (_opp_client, opp):
        match = await _create_match(api_client, opp.id, best_of=3)

        payload = {
            "games": [
                {"game_number": 1, "side_1_points": 11, "side_2_points": 4},
                {"game_number": 2, "side_1_points": 11, "side_2_points": 7},
            ]
        }
        first = await api_client.post(
            f"/v1/matches/{match['id']}/results", json=payload
        )
        assert first.status_code == 201

        second = await api_client.post(
            f"/v1/matches/{match['id']}/results", json=payload
        )
        assert second.status_code == 409
        # The 409 body carries the viewer-relative negotiation state.
        detail = second.json()["detail"]
        assert detail["viewer_state"] == "awaiting"
        assert (
            detail["standing_result"]["id"]
            == first.json()["negotiation"]["standing_result"]["id"]
        )


async def test_propose_first_post_no_longer_guards_scratchpad_divergence(
    api_client: AsyncClient, db_session: AsyncSession
):
    """ADR-0005 / #825: the first post no longer inspects the committed
    scratchpad. A board that overwrites a game a concurrent participant committed
    is now accepted — it compacts, validates, and mints the standing result. The
    poster's board wins; reconciliation is the opponent's acceptance review plus
    the per-game version guard, not a pre-mint board-divergence 409.

    Repro (the old D1 case): the creator (side 1) commits games 1-2 in their own
    favor, the opponent (side 2) commits game 3 in *theirs*, then the creator —
    stale — posts a 3-0 board overwriting game 3. Previously a
    ``MatchResultBoardConflict`` 409; now a 201 with the poster's board."""
    await start_session(api_client, db_session)
    async with opponent_session(db_session, "stale-poster-rival") as (
        opp_client,
        opp,
    ):
        match = await _create_match(api_client, opp.id, best_of=5)
        # Creator commits games 1 + 2 (their wins).
        for n in (1, 2):
            await api_client.post(
                f"/v1/matches/{match['id']}/games/{n}/scores/new",
                json={"side_1_points": 11, "side_2_points": 3},
            )
        # Opponent commits game 3 in their own favor — the game the stale poster
        # never saw.
        opp_g3 = await opp_client.post(
            f"/v1/matches/{match['id']}/games/3/scores/new",
            json={"side_1_points": 3, "side_2_points": 11},
        )
        assert opp_g3.status_code == 201

        # Stale poster posts a 3-0 sweep, overwriting the opponent's game 3.
        response = await api_client.post(
            f"/v1/matches/{match['id']}/results",
            json={
                "games": [
                    {"game_number": 1, "side_1_points": 11, "side_2_points": 3},
                    {"game_number": 2, "side_1_points": 11, "side_2_points": 3},
                    {"game_number": 3, "side_1_points": 11, "side_2_points": 0},
                ]
            },
        )
        # Accepted, not rejected: the poster's board is minted and stands for the
        # opponent to accept/counter (rated two-human match).
        assert response.status_code == 201
        body = response.json()
        assert body["status"] == "in_progress"
        g3 = next(g for g in body["games"] if g["game_number"] == 3)
        assert g3["score"]["side_1_points"] == 11
        assert g3["score"]["side_2_points"] == 0
        # The result row was minted (standing), and the canonical game 3 now
        # carries the poster's overwrite.
        results = (await db_session.execute(select(MatchResult))).scalars().all()
        assert len(results) == 1
        g3_rows = (
            (
                await db_session.execute(
                    select(MatchGameScore)
                    .join(MatchGame)
                    .where(MatchGame.game_number == 3)
                )
            )
            .scalars()
            .all()
        )
        assert len(g3_rows) == 1
        assert (g3_rows[0].side_1_points, g3_rows[0].side_2_points) == (11, 0)


async def test_propose_undecided_board_is_422(
    api_client: AsyncClient, db_session: AsyncSession
):
    """The decided-board hard gate: an undecided board can't be a proposal.
    A 1-1 best-of-3 trips ``_validate_finalize_games`` → 422 before any result
    row is minted."""
    await start_session(api_client, db_session)
    async with opponent_session(db_session, "rival") as (_opp_client, opp):
        match = await _create_match(api_client, opp.id, best_of=3)
        response = await api_client.post(
            f"/v1/matches/{match['id']}/results",
            json={
                "games": [
                    {"game_number": 1, "side_1_points": 11, "side_2_points": 4},
                    {"game_number": 2, "side_1_points": 4, "side_2_points": 11},
                ]
            },
        )
        assert response.status_code == 422
        assert "decided" in response.json()["detail"]
        # No result row was minted.
        results = (await db_session.execute(select(MatchResult))).scalars().all()
        assert results == []


async def _propose(
    client: AsyncClient,
    match_id: str,
    *,
    s1: int,
    s2: int,
    supersedes: str | None = None,
) -> dict:
    """Propose a best-of-1 result with the given game-1 score (optionally a
    counter superseding ``supersedes``). Returns the response body."""
    body: dict[str, object] = {
        "games": [{"game_number": 1, "side_1_points": s1, "side_2_points": s2}]
    }
    if supersedes is not None:
        body["supersedes_result_id"] = supersedes
    response = await client.post(f"/v1/matches/{match_id}/results", json=body)
    return {"status": response.status_code, "body": response.json()}


async def test_propose_on_voided_match_is_409(
    api_client: AsyncClient, db_session: AsyncSession
):
    """A terminal (voided) match is closed to new proposals. A match voided
    before any result was posted has no result rows to gate on, so the propose
    handler guards the status explicitly — otherwise a first-post would silently
    un-void it back to ``in_progress``."""
    await start_session(api_client, db_session)
    async with opponent_session(db_session, "voided-rival") as (_opp_client, opp):
        match = await _create_match(api_client, opp.id, best_of=1)
        await db_session.execute(
            update(Match)
            .where(Match.id == uuid.UUID(match["id"]))
            .values(status=MatchStatus.voided)
        )
        await db_session.commit()

        result = await _propose(api_client, match["id"], s1=11, s2=4)
        assert result["status"] == 409, result

        # The rejected propose left the match voided — it didn't un-void it.
        reloaded = (
            await db_session.execute(
                select(Match).where(Match.id == uuid.UUID(match["id"]))
            )
        ).scalar_one()
        assert reloaded.status == MatchStatus.voided


async def test_propose_self_edit_chain_supersedes_own_proposal(
    api_client: AsyncClient, db_session: AsyncSession
):
    """A proposer may correct their own standing proposal by countering it
    (``supersedes_result_id`` = their own standing result id). The chain stays
    linear and the new row is the standing one; from the opponent's view it's a
    plain ``review`` (no prior proposal of theirs to diff against)."""
    await start_session(api_client, db_session)
    async with opponent_session(db_session, "rival") as (opp_client, opp):
        match = await _create_match(api_client, opp.id, best_of=1)
        first = await _propose(api_client, match["id"], s1=11, s2=4)
        assert first["status"] == 201
        first_id = first["body"]["negotiation"]["standing_result"]["id"]

        # Same proposer corrects their own board: 11-4 → 11-9.
        second = await _propose(
            api_client, match["id"], s1=11, s2=9, supersedes=first_id
        )
        assert second["status"] == 201, second
        second_id = second["body"]["negotiation"]["standing_result"]["id"]
        assert second_id != first_id

        # The chain is linear: the new row supersedes the first.
        results = (await db_session.execute(select(MatchResult))).scalars().all()
        by_id = {r.id: r for r in results}
        assert len(results) == 2
        assert by_id[uuid.UUID(second_id)].supersedes_result_id == uuid.UUID(first_id)

        # The opponent has never proposed → their view is ``review`` (no diff).
        opp_view = (await opp_client.get(f"/v1/matches/{match['id']}")).json()
        opp_neg = opp_view["negotiation"]
        assert opp_neg["viewer_state"] == "review"
        assert opp_neg["your_turn"] is True
        assert opp_neg["prior_result"] is None
        assert opp_neg["diff"] is None
        assert opp_neg["standing_result"]["id"] == second_id


async def test_propose_counter_chain_across_sides(
    api_client: AsyncClient, db_session: AsyncSession
):
    """Each side can counter the other's standing proposal. The chain grows
    linearly; the standing result flips to whoever proposed last, and ``my_side``
    relative ``your_turn`` flips with it."""
    me = await start_session(api_client, db_session)
    async with opponent_session(db_session, "rival") as (opp_client, opp):
        match = await _create_match(api_client, opp.id, best_of=1)
        # I propose side-1 win.
        first = await _propose(api_client, match["id"], s1=11, s2=4)
        first_id = first["body"]["negotiation"]["standing_result"]["id"]

        # The opponent counters: side-2 win, superseding my proposal.
        counter = await _propose(
            opp_client, match["id"], s1=4, s2=11, supersedes=first_id
        )
        assert counter["status"] == 201, counter
        counter_id = counter["body"]["negotiation"]["standing_result"]["id"]

        # From my view, the opponent now holds the standing proposal and it
        # corrects my own prior one → ``corrected`` with a diff.
        my_view = (await api_client.get(f"/v1/matches/{match['id']}")).json()
        my_neg = my_view["negotiation"]
        assert my_neg["viewer_state"] == "corrected"
        assert my_neg["your_turn"] is True
        assert my_neg["standing_result"]["id"] == counter_id
        assert my_neg["standing_result"]["submitted_by"] == str(opp.id)
        assert my_neg["prior_result"]["id"] == first_id
        assert my_neg["prior_result"]["submitted_by"] == str(me.id)
        # The diff is computed from my own prior proposal to the standing one.
        assert my_neg["diff"] == [
            {
                "game_number": 1,
                "old": {"game_number": 1, "side_1_points": 11, "side_2_points": 4},
                "new": {"game_number": 1, "side_1_points": 4, "side_2_points": 11},
            }
        ]

        # I counter back to my original claim, superseding the opponent's.
        recounter = await _propose(
            api_client, match["id"], s1=11, s2=4, supersedes=counter_id
        )
        assert recounter["status"] == 201, recounter
        results = (await db_session.execute(select(MatchResult))).scalars().all()
        assert len(results) == 3


async def _propose_board(
    client: AsyncClient,
    match_id: str,
    games: list[tuple[int, int]],
    *,
    supersedes: str | None = None,
) -> dict:
    """Propose a multi-game board (list of ``(side_1, side_2)`` per game).
    Returns the response body wrapper (``status`` + ``body``)."""
    body: dict[str, object] = {
        "games": [
            {"game_number": i, "side_1_points": s1, "side_2_points": s2}
            for i, (s1, s2) in enumerate(games, start=1)
        ]
    }
    if supersedes is not None:
        body["supersedes_result_id"] = supersedes
    response = await client.post(f"/v1/matches/{match_id}/results", json=body)
    return {"status": response.status_code, "body": response.json()}


async def test_negotiation_diff_shows_removed_game_when_board_shortens(
    api_client: AsyncClient, db_session: AsyncSession
):
    """Regression: a correction that DROPS a game must surface in the diff.

    Per CONTEXT.md "Correction" / ADR-0001 a correction may add, remove, or
    change games. I propose a 3–1 board (four games); the opponent counters with
    a 3–0 board (three games), which flips game 3's winner (so the board clinches
    a game earlier) and drops game 4 entirely. From my view the diff must report
    BOTH the game-3 change AND the game-4 removal (``new`` null), ordered by
    game number — otherwise the accept decision is made on an understated diff."""
    await start_session(api_client, db_session)
    async with opponent_session(db_session, "shorten-rival") as (opp_client, opp):
        match = await _create_match(api_client, opp.id, best_of=5)
        # My board: S1 wins g1,g2,g4; S2 wins g3 → 3–1, decided at game 4.
        mine = await _propose_board(
            api_client,
            match["id"],
            [(11, 4), (11, 4), (4, 11), (11, 4)],
        )
        assert mine["status"] == 201, mine
        mine_id = mine["body"]["negotiation"]["standing_result"]["id"]

        # Opponent counters: S1 sweeps g1–g3 → 3–0, decided at game 3, game 4 gone.
        counter = await _propose_board(
            opp_client,
            match["id"],
            [(11, 4), (11, 4), (11, 4)],
            supersedes=mine_id,
        )
        assert counter["status"] == 201, counter

        my_neg = (await api_client.get(f"/v1/matches/{match['id']}")).json()[
            "negotiation"
        ]
        assert my_neg["viewer_state"] == "corrected"
        # Game 1/2 unchanged → skipped. Game 3 changed, game 4 removed, in order.
        assert my_neg["diff"] == [
            {
                "game_number": 3,
                "old": {"game_number": 3, "side_1_points": 4, "side_2_points": 11},
                "new": {"game_number": 3, "side_1_points": 11, "side_2_points": 4},
            },
            {
                "game_number": 4,
                "old": {"game_number": 4, "side_1_points": 11, "side_2_points": 4},
                "new": None,
            },
        ]


# ----- negotiation BFF oracle (SPEC §4 worked cases) ----------------------
#
# Each case below pins the EXPECTED viewer_state + diff from the SPEC, computed
# by hand from the chain — NOT read off the implementation. A failure here means
# the implementation drifted from the contract; fix app/, never the assertion.


async def test_negotiation_review_after_opponent_self_edit_has_null_diff(
    api_client: AsyncClient, db_session: AsyncSession
):
    """SPEC §4 — review-after-opponent-self-edit→null diff.

    Chain: the OPPONENT proposes (A), then the opponent corrects their OWN
    proposal (B supersedes A). The viewer (me) has never proposed. The baseline
    walk back from the standing result finds no proposal on the viewer's own
    side, so the viewer's state collapses to ``review`` with ``prior_result``
    and ``diff`` both null — the opponent's intermediate self-edit produces no
    diff for the viewer."""
    await start_session(api_client, db_session)
    async with opponent_session(db_session, "self-edit-opp") as (opp_client, opp):
        match = await _create_match(api_client, opp.id, best_of=1)
        # Opponent proposes A (side-2 win), then self-edits to B (different
        # side-2 win) by superseding their own A.
        a = await _propose(opp_client, match["id"], s1=4, s2=11)
        a_id = a["body"]["negotiation"]["standing_result"]["id"]
        b = await _propose(opp_client, match["id"], s1=6, s2=11, supersedes=a_id)
        assert b["status"] == 201, b
        b_id = b["body"]["negotiation"]["standing_result"]["id"]

        # The viewer (me) never proposed → EXPECTED review, null diff.
        view = (await api_client.get(f"/v1/matches/{match['id']}")).json()
        neg = view["negotiation"]
        assert neg["viewer_state"] == "review"
        assert neg["your_turn"] is True
        assert neg["prior_result"] is None
        assert neg["diff"] is None
        assert neg["standing_result"]["id"] == b_id


async def test_negotiation_corrected_collapses_flip_flop(
    api_client: AsyncClient, db_session: AsyncSession
):
    """SPEC §4 — corrected-collapses-flip-flop.

    Chain A(me)→B(opp)→C(me)→D(opp), all best-of-1 corrections. From MY view the
    standing result is D (the opponent's), and the baseline is my OWN last
    proposal C (NOT the immediately-superseded B). EXPECTED viewer_state
    ``corrected``; ``prior_result`` = C; ``diff`` = C vs D (collapsing the
    opponent's B in between). C and D differ in their points, so the diff is the
    single game with old=C, new=D."""
    await start_session(api_client, db_session)
    async with opponent_session(db_session, "flip-flop-opp") as (opp_client, opp):
        match = await _create_match(api_client, opp.id, best_of=1)
        # A (me): side-1 win 11-4.
        a = await _propose(api_client, match["id"], s1=11, s2=4)
        a_id = a["body"]["negotiation"]["standing_result"]["id"]
        # B (opp): side-2 win 5-11, superseding A.
        b = await _propose(opp_client, match["id"], s1=5, s2=11, supersedes=a_id)
        b_id = b["body"]["negotiation"]["standing_result"]["id"]
        # C (me): side-1 win 11-7, superseding B — my OWN last proposal.
        c = await _propose(api_client, match["id"], s1=11, s2=7, supersedes=b_id)
        c_id = c["body"]["negotiation"]["standing_result"]["id"]
        # D (opp): side-2 win 9-11, superseding C — the standing result.
        d = await _propose(opp_client, match["id"], s1=9, s2=11, supersedes=c_id)
        d_id = d["body"]["negotiation"]["standing_result"]["id"]

        view = (await api_client.get(f"/v1/matches/{match['id']}")).json()
        neg = view["negotiation"]
        # EXPECTED corrected, diff baseline = my own C (not the superseded B).
        assert neg["viewer_state"] == "corrected"
        assert neg["your_turn"] is True
        assert neg["standing_result"]["id"] == d_id
        assert neg["prior_result"]["id"] == c_id
        assert neg["diff"] == [
            {
                "game_number": 1,
                "old": {"game_number": 1, "side_1_points": 11, "side_2_points": 7},
                "new": {"game_number": 1, "side_1_points": 9, "side_2_points": 11},
            }
        ]


async def test_propose_stale_supersedes_id_is_409(
    api_client: AsyncClient, db_session: AsyncSession
):
    """A counter must target the *current* standing proposal. If the caller
    supersedes a result that has since been superseded by another counter, the
    id no longer matches the standing one → 409 with the moved-on state."""
    await start_session(api_client, db_session)
    async with opponent_session(db_session, "rival") as (opp_client, opp):
        match = await _create_match(api_client, opp.id, best_of=1)
        first = await _propose(api_client, match["id"], s1=11, s2=4)
        first_id = first["body"]["negotiation"]["standing_result"]["id"]

        # The opponent counters first, advancing the standing proposal.
        counter = await _propose(
            opp_client, match["id"], s1=4, s2=11, supersedes=first_id
        )
        assert counter["status"] == 201

        # I try to counter the now-stale first proposal — it's been superseded.
        stale = await _propose(
            api_client, match["id"], s1=11, s2=6, supersedes=first_id
        )
        assert stale["status"] == 409, stale
        # The moved-on standing result is the opponent's counter.
        assert (
            stale["body"]["detail"]["standing_result"]["id"]
            == counter["body"]["negotiation"]["standing_result"]["id"]
        )


async def test_concurrent_propose_counters_nowait_409(
    api_client: AsyncClient, db_session: AsyncSession, engine: AsyncEngine
):
    """Two counters racing to supersede the same parent: the
    ``UNIQUE(supersedes_result_id)`` constraint keeps the chain linear, so one
    commits and the other gets a clean 409 carrying the moved-on negotiation
    state — never two successors on one parent.

    The handler also takes the row lock with ``FOR UPDATE NOWAIT`` on propose,
    so the racer that loses the lock fails fast; whichever guard fires, the
    result is one winner + one 409 and a single linear chain."""
    me = await start_session(api_client, db_session)
    async with opponent_session(db_session, "race-opp") as (_opp_client, opp):
        match = await _create_match(api_client, opp.id, best_of=1)
        match_id = uuid.UUID(match["id"])
        me_id = me.id
        # Seed a standing first proposal both racers will try to supersede.
        first = await _propose(api_client, match["id"], s1=11, s2=4)
        parent_id = uuid.UUID(first["body"]["negotiation"]["standing_result"]["id"])

        make_session = async_sessionmaker(engine, expire_on_commit=False)

        async def run(s2: int) -> object:
            async with make_session() as session:
                poster = (
                    await session.execute(select(User).where(User.id == me_id))
                ).scalar_one()
                notifications = NotificationService(session, FakeSender())
                payload = MatchResultsWrite(
                    games=[
                        MatchResultsGameWrite(
                            game_number=1, side_1_points=11, side_2_points=s2
                        )
                    ],
                    supersedes_result_id=parent_id,
                )
                try:
                    await post_match_result(
                        match_id,
                        payload,
                        poster,
                        session,
                        _match_service(session),
                        notifications,
                    )
                    return "ok"
                except HTTPException as exc:
                    return exc.status_code

        outcomes = await asyncio.gather(run(5), run(6))
        # Exactly one counter wins; the other is cleanly rejected (409), never a
        # second successor on the same parent.
        assert sorted(str(o) for o in outcomes) == ["409", "ok"], outcomes

        async with make_session() as verify:
            final = (
                await verify.execute(
                    select(Match)
                    .where(Match.id == match_id)
                    .options(selectinload(Match.results))
                )
            ).scalar_one()
            # The first proposal plus exactly one successor — the chain is linear.
            assert len(final.results) == 2
            successors = [
                r for r in final.results if r.supersedes_result_id == parent_id
            ]
            assert len(successors) == 1


async def test_concurrent_results_posts_do_not_pile_up(
    api_client: AsyncClient, db_session: AsyncSession, engine: AsyncEngine
):
    """Regression for #641. A double-tapped "Finalize result" fires two
    concurrent ``POST /results`` on the same match. The winner posts the
    result; the loser must fail *fast* with a clean 409 instead of blocking on
    the row lock for the duration of the in-flight post — that pile-up (each
    waiter parking a pooled DB connection) is what wedged the whole instance.

    ``post_match_result`` takes the lock with ``FOR UPDATE NOWAIT``, so the
    racer that loses the lock raises immediately. Like
    ``test_concurrent_confirm_and_dispute_serialize`` this drives the handler on
    *separate* sessions via ``asyncio.gather`` so the lock genuinely contends.
    """
    me = await start_session(api_client, db_session)
    async with opponent_session(db_session, "race-opp") as (_opp_client, opp):
        match = await _create_match(api_client, opp.id, best_of=1)
        match_id = uuid.UUID(match["id"])
        me_id = me.id

        make_session = async_sessionmaker(engine, expire_on_commit=False)
        payload = MatchResultsWrite(
            games=[
                MatchResultsGameWrite(game_number=1, side_1_points=11, side_2_points=4)
            ]
        )

        async def run() -> object:
            async with make_session() as session:
                poster = (
                    await session.execute(select(User).where(User.id == me_id))
                ).scalar_one()
                notifications = NotificationService(session, FakeSender())
                try:
                    await post_match_result(
                        match_id,
                        payload,
                        poster,
                        session,
                        _match_service(session),
                        notifications,
                    )
                    return "ok"
                except HTTPException as exc:
                    return exc.detail

        outcomes = await asyncio.gather(run(), run())

        # One result posted; the other cleanly rejected — never two successes.
        # The loser's message is the NOWAIT fast-fail, not the blocking
        # ``_enforce_scorable`` 409: under asyncio's single loop the winner
        # acquires the lock at its first await and the loser hits NOWAIT before
        # the winner commits — so this asserts the *fast* path, the actual #641
        # fix, rather than a 409 that only arrives after a full lock-wait.
        assert sorted(str(o) for o in outcomes) == [
            "A result is already being posted for this match. "
            "Refresh to see the latest.",
            "ok",
        ], outcomes

        # The committed match holds its invariants: exactly one posted result
        # and the single canonical game, with no duplicate/orphan rows.
        async with make_session() as verify:
            final = (
                await verify.execute(
                    select(Match)
                    .where(Match.id == match_id)
                    .options(
                        selectinload(Match.results),
                        selectinload(Match.games),
                    )
                )
            ).scalar_one()
            assert len(final.results) == 1
            assert len(final.games) == 1


async def test_score_endpoints_409_once_result_is_posted(
    api_client: AsyncClient, db_session: AsyncSession
):
    """Once a result is proposed the scratchpad freezes (#715): every per-game
    write returns 409. The board now only changes through propose/accept."""
    await start_session(api_client, db_session)
    async with opponent_session(db_session, "rival") as (_opp_client, opp):
        match = await _create_match(api_client, opp.id, best_of=3)
        await api_client.post(
            f"/v1/matches/{match['id']}/results",
            json={
                "games": [
                    {"game_number": 1, "side_1_points": 11, "side_2_points": 4},
                    {"game_number": 2, "side_1_points": 11, "side_2_points": 7},
                ]
            },
        )

        # Every write path returns 409 while the proposed result is standing.
        post = await api_client.post(
            f"/v1/matches/{match['id']}/games/1/scores/new",
            json={"side_1_points": 8, "side_2_points": 11},
        )
        assert post.status_code == 409
        put = await api_client.put(
            f"/v1/matches/{match['id']}/games/1/scores",
            json={"side_1_points": 8, "side_2_points": 11, "expected_version": 1},
        )
        assert put.status_code == 409
        delete = await api_client.delete(f"/v1/matches/{match['id']}/games/1/scores")
        assert delete.status_code == 409


async def test_score_endpoints_409_once_match_is_completed(
    api_client: AsyncClient, db_session: AsyncSession
):
    """After acceptance lands and the match is completed, every write
    path 409s — there's no edit affordance on a finalized match."""
    await start_session(api_client, db_session)
    async with opponent_session(db_session, "rival") as (opp_client, opp):
        match = await _create_match(api_client, opp.id, best_of=3)
        await api_client.post(
            f"/v1/matches/{match['id']}/results",
            json={
                "games": [
                    {"game_number": 1, "side_1_points": 11, "side_2_points": 4},
                    {"game_number": 2, "side_1_points": 11, "side_2_points": 7},
                ]
            },
        )
        await accept_standing_result(opp_client, match["id"])

        post = await api_client.post(
            f"/v1/matches/{match['id']}/games/1/scores/new",
            json={"side_1_points": 8, "side_2_points": 11},
        )
        assert post.status_code == 409
        put = await api_client.put(
            f"/v1/matches/{match['id']}/games/1/scores",
            json={"side_1_points": 8, "side_2_points": 11, "expected_version": 1},
        )
        assert put.status_code == 409
        delete = await api_client.delete(f"/v1/matches/{match['id']}/games/1/scores")
        assert delete.status_code == 409


@pytest.mark.parametrize(
    "games,reason_contains",
    [
        # NB: a *gap* is no longer a 422 — a gappy but decided board (e.g. games
        # 1 and 3, side 1 winning both) is compacted to a contiguous board and
        # finalizes. See ``test_finalize_compacts_gappy_decided_board``. Only a
        # real overrun (games genuinely scored past the clinch, below) still 422s.
        # Duplicate game numbers.
        (
            [
                {"game_number": 1, "side_1_points": 11, "side_2_points": 4},
                {"game_number": 1, "side_1_points": 11, "side_2_points": 7},
            ],
            "Duplicate",
        ),
        # Undecided — 1-1 in best-of-3 (need 2 wins).
        (
            [
                {"game_number": 1, "side_1_points": 11, "side_2_points": 4},
                {"game_number": 2, "side_1_points": 4, "side_2_points": 11},
            ],
            "decided",
        ),
        # Scored games past the decider — won 2-0 in game 2 but a game 3 is
        # also reported.
        (
            [
                {"game_number": 1, "side_1_points": 11, "side_2_points": 4},
                {"game_number": 2, "side_1_points": 11, "side_2_points": 7},
                {"game_number": 3, "side_1_points": 11, "side_2_points": 9},
            ],
            "past the deciding game",
        ),
        # game_number > best_of.
        (
            [
                {"game_number": 1, "side_1_points": 11, "side_2_points": 4},
                {"game_number": 2, "side_1_points": 11, "side_2_points": 7},
                {"game_number": 3, "side_1_points": 11, "side_2_points": 9},
                {"game_number": 4, "side_1_points": 11, "side_2_points": 9},
            ],
            "best_of",
        ),
    ],
)
async def test_finalize_422_on_invalid_payload(
    api_client: AsyncClient,
    db_session: AsyncSession,
    games: list[dict[str, int]],
    reason_contains: str,
):
    await start_session(api_client, db_session)
    opp = await make_user(db_session, "rival")
    match = await _create_match(api_client, opp.id, best_of=3)

    response = await api_client.post(
        f"/v1/matches/{match['id']}/results", json={"games": games}
    )
    assert response.status_code == 422
    assert reason_contains in response.json()["detail"]


async def test_finalize_422_on_illegal_per_game_score(
    api_client: AsyncClient, db_session: AsyncSession
):
    # An individual game with an illegal score (11-10, no win-by-2) trips
    # the per-game validator inside MatchResultsGameWrite.
    await start_session(api_client, db_session)
    opp = await make_user(db_session, "rival")
    match = await _create_match(api_client, opp.id, best_of=3)

    response = await api_client.post(
        f"/v1/matches/{match['id']}/results",
        json={
            "games": [
                {"game_number": 1, "side_1_points": 11, "side_2_points": 4},
                {"game_number": 2, "side_1_points": 11, "side_2_points": 10},
            ]
        },
    )
    assert response.status_code == 422


async def test_can_finalize_flag_tracks_saved_scores(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    opp = await make_user(db_session, "rival")
    match = await _create_match(api_client, opp.id, best_of=3)

    after_g1 = (
        await api_client.post(
            f"/v1/matches/{match['id']}/games/1/scores/new",
            json={"side_1_points": 11, "side_2_points": 4},
        )
    ).json()
    # One game in — not enough to decide a best-of-3.
    assert after_g1["can_finalize"] is False

    after_g2 = (
        await api_client.post(
            f"/v1/matches/{match['id']}/games/2/scores/new",
            json={"side_1_points": 11, "side_2_points": 7},
        )
    ).json()
    # Same winner in both — match is decided.
    assert after_g2["can_finalize"] is True

    # Splitting g1/g2 leaves the match 1-1: undecided.
    edited = (
        await api_client.put(
            f"/v1/matches/{match['id']}/games/2/scores",
            json={"side_1_points": 5, "side_2_points": 11, "expected_version": 1},
        )
    ).json()
    assert edited["can_finalize"] is False


async def test_finalize_compacts_gappy_decided_board(
    api_client: AsyncClient, db_session: AsyncSession
):
    """#742: an out-of-order clinch posts a gappy-but-decided board (games 1 and
    3, side 1 winning both, no game 2). It used to 422 ("consecutively"); now it
    is *compacted* to a contiguous ``[1, 2]`` board and finalizes 2-0. The
    committed games and the immutable result snapshot are both contiguous."""
    await start_session(api_client, db_session)
    async with opponent_session(db_session, "rival") as (_opp_client, opp):
        match = await _create_match(api_client, opp.id, best_of=3)

        response = await api_client.post(
            f"/v1/matches/{match['id']}/results",
            json={
                "games": [
                    {"game_number": 1, "side_1_points": 11, "side_2_points": 4},
                    {"game_number": 3, "side_1_points": 11, "side_2_points": 7},
                ]
            },
        )
        assert response.status_code == 201, response.json()
        body = response.json()

        # The gap is closed: the stored board is contiguous 1..2, not 1,3.
        games = sorted(body["games"], key=lambda g: g["game_number"])
        assert [g["game_number"] for g in games] == [1, 2]
        # Renumbering preserves each game's score — game 3's 11-7 becomes game 2.
        assert games[1]["score"]["side_1_points"] == 11
        assert games[1]["score"]["side_2_points"] == 7
        # Side 1 swept both games → 2-0.
        sides = sorted(body["sides"], key=lambda s: s["side_number"])
        assert [s["games_won"] for s in sides] == [2, 0]

        # The immutable result snapshot is contiguous too.
        results = (await db_session.execute(select(MatchResult))).scalars().all()
        assert len(results) == 1
        assert [g["game_number"] for g in results[0].games] == [1, 2]

        # No orphan scratchpad rows survive under the old game numbers.
        game_rows = (await db_session.execute(select(MatchGame))).scalars().all()
        assert sorted(g.game_number for g in game_rows) == [1, 2]


async def test_can_finalize_true_for_gappy_decided_saved_board(
    api_client: AsyncClient, db_session: AsyncSession
):
    """#742 self-heal: a saved scratchpad where the deciding game landed out of
    order (games 1-3 then game 5, leaving game 4 blank) is decided once
    compacted, so ``can_finalize`` reports true — the SaveBanner then offers
    "Post result" and the user recovers from the previously-stuck state."""
    await start_session(api_client, db_session)
    opp = await make_user(db_session, "rival")
    match = await _create_match(api_client, opp.id, best_of=7)

    # Side 1 wins games 1-3, then clinches the 4th win on game 5 (game 4 blank).
    await _sweep_games(api_client, match["id"], [1, 2, 3])
    after_g5 = await api_client.post(
        f"/v1/matches/{match['id']}/games/5/scores/new",
        json={"side_1_points": 11, "side_2_points": 2},
    )
    assert after_g5.status_code == 201, after_g5.json()
    # The gappy board [1,2,3,5] compacts to [1,2,3,4] — decided, so finalizable.
    assert after_g5.json()["can_finalize"] is True


# ----- league binding -----------------------------------------------------


async def test_create_match_without_league_id_uses_default_league(
    api_client: AsyncClient,
    db_session: AsyncSession,
    default_league: League,
):
    await start_session(api_client, db_session)
    response = await api_client.post("/v1/matches", json={"best_of": 3, "rated": False})
    assert response.status_code == 201
    body = response.json()
    assert body["league"]["id"] == str(default_league.id)
    assert body["league"]["name"] == default_league.name


async def test_create_match_with_explicit_league_id_uses_that_league(
    api_client: AsyncClient,
    db_session: AsyncSession,
    default_league: League,
):
    other = League(
        name="Side League",
        description="Not the default.",
        visibility=LeagueVisibility.private,
        rating_strategy_id=default_league.rating_strategy_id,
    )
    db_session.add(other)
    await db_session.commit()
    await db_session.refresh(other)

    await start_session(api_client, db_session)
    response = await api_client.post(
        "/v1/matches",
        json={"best_of": 3, "rated": False, "league_id": str(other.id)},
    )
    assert response.status_code == 201
    body = response.json()
    assert body["league"]["id"] == str(other.id)
    assert body["league"]["name"] == "Side League"


async def test_create_match_with_unknown_league_id_is_404(
    api_client: AsyncClient,
    db_session: AsyncSession,
    default_league: League,
):
    await start_session(api_client, db_session)
    response = await api_client.post(
        "/v1/matches",
        json={
            "best_of": 3,
            "rated": False,
            "league_id": str(uuid.uuid4()),
        },
    )
    assert response.status_code == 404
    assert "league" in response.json()["detail"].lower()


async def test_create_match_with_no_default_seeded_is_500(
    api_client: AsyncClient,
    db_session: AsyncSession,
    default_league: League,
):
    await start_session(api_client, db_session)
    # Remove the autouse default after the session has already attached a
    # membership; the create-match call should now have no fallback to land on.
    await db_session.delete(default_league)
    await db_session.commit()

    response = await api_client.post("/v1/matches", json={"best_of": 3, "rated": False})
    assert response.status_code == 500


async def test_list_and_get_match_include_league(
    api_client: AsyncClient,
    db_session: AsyncSession,
    default_league: League,
):
    await start_session(api_client, db_session)
    opp = await make_user(db_session, "league-rival")
    created = (
        await api_client.post(
            "/v1/matches",
            json={
                "opponent_user_id": str(opp.id),
                "best_of": 3,
                "rated": True,
            },
        )
    ).json()

    detail = (await api_client.get(f"/v1/matches/{created['id']}")).json()
    assert detail["league"]["id"] == str(default_league.id)
    assert detail["league"]["name"] == default_league.name

    listing = (await api_client.get("/v1/matches")).json()
    assert listing["items"][0]["league"]["id"] == str(default_league.id)


# ----- recent form + head to head -----------------------------------------


async def _play_match_to_completion(
    client: AsyncClient,
    opp_client: AsyncClient,
    opp_id: uuid.UUID,
    best_of: int,
    side_1_wins: bool,
) -> dict:
    """Create a match, propose the result, and have the opponent accept it —
    the full propose/accept dance. The chosen side wins the minimum number of
    games needed to clinch. Returns the post-acceptance MatchDetails body."""
    match = await _create_match(client, opp_id, best_of=best_of)
    needed = best_of // 2 + 1
    s1, s2 = (11, 5) if side_1_wins else (5, 11)
    post = await client.post(
        f"/v1/matches/{match['id']}/results",
        json={
            "games": [
                {"game_number": n, "side_1_points": s1, "side_2_points": s2}
                for n in range(1, needed + 1)
            ]
        },
    )
    assert post.status_code == 201
    body = await accept_standing_result(opp_client, match["id"])
    assert body["status"] == "completed"
    return body


async def test_details_includes_empty_recent_form_for_first_meeting(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    opp = await make_user(db_session, "first-rival")
    created = await _create_match(api_client, opp.id, best_of=3)

    detail = (await api_client.get(f"/v1/matches/{created['id']}")).json()
    assert detail["head_to_head"] == {
        "total_meetings": 0,
        "side_1_wins": 0,
        "side_2_wins": 0,
        "recent_meetings": [],
    }
    # Both players are in recent_form, both with empty results lists.
    forms = {f["user_id"]: f for f in detail["recent_form"]}
    assert len(forms) == 2
    for f in forms.values():
        assert f["recent_results"] == []


async def test_details_recent_form_lists_each_player_previous_results(
    api_client: AsyncClient, db_session: AsyncSession
):
    me = await start_session(api_client, db_session)
    opp = await make_user(db_session, "form-rival")
    # Play two finished matches with a third party so each side has its own
    # prior history that's *not* a head-to-head meeting.
    async with opponent_session(db_session, "third-party") as (other_client, other):
        await _play_match_to_completion(
            api_client, other_client, other.id, best_of=3, side_1_wins=True
        )
        await _play_match_to_completion(
            api_client, other_client, other.id, best_of=3, side_1_wins=False
        )
    # Now start a head-to-head match and ask for its details.
    current = await _create_match(api_client, opp.id, best_of=3)
    detail = (await api_client.get(f"/v1/matches/{current['id']}")).json()

    forms = {f["user_id"]: f for f in detail["recent_form"]}
    # I have 2 prior completed matches (1 W, 1 L) against third-party.
    mine = forms[str(me.id)]
    assert {r["is_win"] for r in mine["recent_results"]} == {True, False}
    assert all(r["opponent_username"] == "third-party" for r in mine["recent_results"])
    # Opp shows up in the form list with no prior completed matches.
    assert forms[str(opp.id)]["recent_results"] == []


async def test_details_recent_form_excludes_the_current_match(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    # Play to completion against this opp, then look up that match's detail.
    async with opponent_session(db_session, "exclude-rival") as (opp_client, opp):
        finished = await _play_match_to_completion(
            api_client, opp_client, opp.id, best_of=3, side_1_wins=True
        )

    detail = (await api_client.get(f"/v1/matches/{finished['id']}")).json()
    forms = {f["user_id"]: f for f in detail["recent_form"]}
    # The finished match itself must not appear in its own recent-form list.
    for f in forms.values():
        assert all(r["match_id"] != finished["id"] for r in f["recent_results"])


async def test_details_recent_form_excludes_matches_after_this_one(
    api_client: AsyncClient, db_session: AsyncSession
):
    """Viewing an older match shows form as it stood then: a match completed
    before this one was created counts; one completed after it does not."""
    me = await start_session(api_client, db_session)
    opp = await make_user(db_session, "after-rival")
    async with opponent_session(db_session, "after-third-party") as (
        other_client,
        other,
    ):
        # A match I finished *before* the viewed match is created.
        earlier = await _play_match_to_completion(
            api_client, other_client, other.id, best_of=3, side_1_wins=True
        )
        # The match we'll view (in progress, so it stays "current" in time).
        current = await _create_match(api_client, opp.id, best_of=3)
        # A match I finish *after* the viewed match was created.
        later = await _play_match_to_completion(
            api_client, other_client, other.id, best_of=3, side_1_wins=False
        )

    detail = (await api_client.get(f"/v1/matches/{current['id']}")).json()
    forms = {f["user_id"]: f for f in detail["recent_form"]}
    my_match_ids = {r["match_id"] for r in forms[str(me.id)]["recent_results"]}
    assert earlier["id"] in my_match_ids
    assert later["id"] not in my_match_ids


async def test_details_recent_form_is_stable_when_a_prior_match_is_edited(
    api_client: AsyncClient, db_session: AsyncSession
):
    """History windows anchor on the stable ``completed_at``, not the mutable
    ``updated_at``. Editing an old completed match *after* the current match was
    created (which bumps ``updated_at`` past it) must not drop it out of recent
    form — it was still completed beforehand."""
    me = await start_session(api_client, db_session)
    opp = await make_user(db_session, "edit-rival")
    async with opponent_session(db_session, "edit-third-party") as (
        other_client,
        other,
    ):
        earlier = await _play_match_to_completion(
            api_client, other_client, other.id, best_of=3, side_1_wins=True
        )
        current = await _create_match(api_client, opp.id, best_of=3)

    # Simulate a late edit to the already-completed prior match: shove its
    # ``updated_at`` to well after the current match's ``created_at``. Under the
    # old (updated_at-based) cutoff this would evict it from recent form.
    current_created_at = datetime.fromisoformat(current["created_at"])
    await db_session.execute(
        update(Match)
        .where(Match.id == uuid.UUID(earlier["id"]))
        .values(updated_at=current_created_at + timedelta(days=1))
    )
    await db_session.commit()

    detail = (await api_client.get(f"/v1/matches/{current['id']}")).json()
    forms = {f["user_id"]: f for f in detail["recent_form"]}
    my_match_ids = {r["match_id"] for r in forms[str(me.id)]["recent_results"]}
    assert earlier["id"] in my_match_ids


async def test_details_head_to_head_counts_prior_meetings_per_side(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    async with opponent_session(db_session, "h2h-rival") as (rival_client, rival):
        # Three completed prior meetings: I win two, lose one.
        await _play_match_to_completion(
            api_client, rival_client, rival.id, best_of=3, side_1_wins=True
        )
        await _play_match_to_completion(
            api_client, rival_client, rival.id, best_of=3, side_1_wins=True
        )
        await _play_match_to_completion(
            api_client, rival_client, rival.id, best_of=3, side_1_wins=False
        )
        # New in-progress match — H2H counts only completed *prior* meetings.
        current = await _create_match(api_client, rival.id, best_of=5)

    detail = (await api_client.get(f"/v1/matches/{current['id']}")).json()
    h2h = detail["head_to_head"]
    assert h2h["total_meetings"] == 3
    assert h2h["side_1_wins"] == 2  # me, on side 1 of the current match
    assert h2h["side_2_wins"] == 1
    # Most-recent meeting is the one I just lost.
    assert h2h["recent_meetings"][0]["winner_side_number"] == 2
    # Every meeting here went through the rated acceptance flow.
    assert all(m["rated"] for m in h2h["recent_meetings"])


async def test_details_head_to_head_flags_rated_vs_unrated_meetings(
    api_client: AsyncClient, db_session: AsyncSession
):
    """Each meeting row carries whether it moved ratings, so the card can mark
    rated meetings apart from casual ones (#500)."""
    await start_session(api_client, db_session)
    async with opponent_session(db_session, "h2h-mixed-rival") as (
        rival_client,
        rival,
    ):
        # A rated prior meeting (full acceptance) ...
        await _play_match_to_completion(
            api_client, rival_client, rival.id, best_of=3, side_1_wins=True
        )
        # ... and an unrated one, which finalizes straight from /results.
        unrated = await api_client.post(
            "/v1/matches",
            json={"opponent_user_id": str(rival.id), "best_of": 3, "rated": False},
        )
        assert unrated.status_code == 201
        unrated_id = unrated.json()["id"]
        await _post_results(api_client, unrated_id)

        current = await _create_match(api_client, rival.id, best_of=5)

    h2h = (await api_client.get(f"/v1/matches/{current['id']}")).json()["head_to_head"]
    rated_by_match = {m["match_id"]: m["rated"] for m in h2h["recent_meetings"]}
    assert rated_by_match[unrated_id] is False
    assert any(rated_by_match.values())


async def test_details_head_to_head_excludes_meetings_after_this_match(
    api_client: AsyncClient, db_session: AsyncSession
):
    """Viewing a match shows the rivalry as it stood going into it: meetings
    completed *after* the viewed match must not appear, and a match that starts
    the rivalry shows no prior meetings (regression for #497)."""
    await start_session(api_client, db_session)
    async with opponent_session(db_session, "h2h-temporal-rival") as (
        rival_client,
        rival,
    ):
        # The match we'll view — first meeting, so it starts the rivalry.
        first = await _play_match_to_completion(
            api_client, rival_client, rival.id, best_of=3, side_1_wins=True
        )
        # Two more meetings completed *after* the viewed match.
        await _play_match_to_completion(
            api_client, rival_client, rival.id, best_of=3, side_1_wins=False
        )
        await _play_match_to_completion(
            api_client, rival_client, rival.id, best_of=3, side_1_wins=True
        )

    detail = (await api_client.get(f"/v1/matches/{first['id']}")).json()
    h2h = detail["head_to_head"]
    # Nothing precedes the first meeting — both rows and aggregates are empty.
    assert h2h == {
        "total_meetings": 0,
        "side_1_wins": 0,
        "side_2_wins": 0,
        "recent_meetings": [],
    }


async def test_details_head_to_head_is_null_for_solo_match(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    created = (
        await api_client.post("/v1/matches", json={"best_of": 3, "rated": False})
    ).json()
    detail = (await api_client.get(f"/v1/matches/{created['id']}")).json()
    assert detail["head_to_head"] is None
    # Only the creator is in recent_form — and they have no prior history.
    assert len(detail["recent_form"]) == 1
    assert detail["recent_form"][0]["recent_results"] == []


async def test_details_recent_form_includes_pre_match_rating_and_career(
    api_client: AsyncClient, db_session: AsyncSession
):
    me = await start_session(api_client, db_session)
    async with opponent_session(db_session, "career-other") as (other_client, other):
        # Two completed wins build up career stats *and* rating history before
        # the head-to-head match is created.
        await _play_match_to_completion(
            api_client, other_client, other.id, best_of=3, side_1_wins=True
        )
        await _play_match_to_completion(
            api_client, other_client, other.id, best_of=3, side_1_wins=True
        )

    opp = await make_user(db_session, "pre-rating-opp")
    current = await _create_match(api_client, opp.id, best_of=3)
    detail = (await api_client.get(f"/v1/matches/{current['id']}")).json()

    forms = {f["user_id"]: f for f in detail["recent_form"]}
    mine = forms[str(me.id)]
    # I had 2 completed matches before this one, both wins.
    assert mine["career_matches_before"] == 2
    assert mine["career_wins_before"] == 2
    # Rating history exists with 3 prior entries (the league-join seed plus
    # one per rated match) and rating_before matches the most-recent entry.
    assert mine["rating_before"] is not None
    assert len(mine["rating_history"]) == 3
    assert mine["rating_history"][-1] == mine["rating_before"]
    # Brand-new opponent: no rating, no career.
    fresh = forms[str(opp.id)]
    assert fresh["rating_before"] is None
    assert fresh["rating_history"] == []
    assert fresh["career_matches_before"] == 0
    assert fresh["career_wins_before"] == 0


async def test_details_recent_form_excludes_self_from_career_count(
    api_client: AsyncClient, db_session: AsyncSession
):
    """A just-completed match's own row in rating_history / its own match
    row must not double-count itself in the BFF. The session user still shows
    their league-join seed (recorded before the match), but none of the
    match's own freshly-written rating rows leak into the pre-match view."""
    me = await start_session(api_client, db_session)
    async with opponent_session(db_session, "self-exclude-opp") as (opp_client, opp):
        finished = await _play_match_to_completion(
            api_client, opp_client, opp.id, best_of=3, side_1_wins=True
        )

    detail = (await api_client.get(f"/v1/matches/{finished['id']}")).json()
    forms = {f["user_id"]: f for f in detail["recent_form"]}
    # No prior matches exist — only the current one — so career counts are 0
    # for both players.
    for f in forms.values():
        assert f["career_matches_before"] == 0
        assert f["career_wins_before"] == 0

    # The session user joined the league at signup, so their pre-match rating
    # is the seeded baseline; the match's own rating rows are excluded.
    mine = forms[str(me.id)]
    assert mine["rating_before"] == 1500.0
    assert mine["rating_history"] == [1500.0]

    # The opponent's session join seeded their rating too — but only the
    # match-sourced rating row would predate the *next* match, and there
    # isn't one — so their pre-match history for this match is just the
    # seed (recorded before the match was created).
    opp_form = forms[str(opp.id)]
    assert opp_form["rating_before"] == 1500.0
    assert opp_form["rating_history"] == [1500.0]


async def test_details_career_count_excludes_only_the_viewed_match(
    api_client: AsyncClient, db_session: AsyncSession
):
    """Viewing a *completed* match counts earlier matches as priors while
    excluding the match being viewed. The single-match sibling test above
    passes even if the ``Match.id != current_match_id`` self-exclusion guard
    were dropped — with two matches between the same pair, only this one bites
    (#198): the first counts, the current is excluded."""
    me = await start_session(api_client, db_session)
    async with opponent_session(db_session, "career-guard-opp") as (
        opp_client,
        opp,
    ):
        await _play_match_to_completion(
            api_client, opp_client, opp.id, best_of=3, side_1_wins=True
        )
        second = await _play_match_to_completion(
            api_client, opp_client, opp.id, best_of=3, side_1_wins=True
        )

    detail = (await api_client.get(f"/v1/matches/{second['id']}")).json()
    forms = {f["user_id"]: f for f in detail["recent_form"]}
    # Exactly one prior counts for each player — the first match — and the
    # current (second) match excludes itself.
    for f in forms.values():
        assert f["career_matches_before"] == 1
    # I won the first match (side 1); the opponent lost it.
    assert forms[str(me.id)]["career_wins_before"] == 1
    assert forms[str(opp.id)]["career_wins_before"] == 0


async def test_details_career_counts_are_per_player(
    api_client: AsyncClient, db_session: AsyncSession
):
    """The batched career-count query must key each player's totals to that
    player: two participants with *different non-zero* histories (2 prior
    matches vs 1) must not collapse onto a single shared count."""
    me = await start_session(api_client, db_session)
    async with opponent_session(db_session, "per-player-opp") as (opp_client, opp):
        # The opponent's only prior — a loss to me.
        await _play_match_to_completion(
            api_client, opp_client, opp.id, best_of=3, side_1_wins=True
        )
    async with opponent_session(db_session, "per-player-third") as (
        third_client,
        third,
    ):
        # A second prior for me only, against someone else.
        await _play_match_to_completion(
            api_client, third_client, third.id, best_of=3, side_1_wins=True
        )

    current = await _create_match(api_client, opp.id, best_of=3)
    detail = (await api_client.get(f"/v1/matches/{current['id']}")).json()

    forms = {f["user_id"]: f for f in detail["recent_form"]}
    assert forms[str(me.id)]["career_matches_before"] == 2
    assert forms[str(me.id)]["career_wins_before"] == 2
    assert forms[str(opp.id)]["career_matches_before"] == 1
    assert forms[str(opp.id)]["career_wins_before"] == 0


async def test_career_before_batches_every_user_into_one_statement(
    db_session: AsyncSession, engine: AsyncEngine
):
    """The career record for N players costs one SQL statement, not N (#195).

    Three ids on purpose: a reintroduced per-user loop emits three statements and
    fails loudly here, where a two-id list could still be read as a coincidence.
    The counter runs on its own fresh ``async_sessionmaker`` session so the setup
    INSERTs (already committed on ``db_session``) can't inflate the count, and so
    the shared session's identity map / pending flushes can't mask a query.
    """
    user_ids = [(await make_user(db_session, f"career-batch-{n}")).id for n in range(3)]

    statements: list[str] = []

    def before(conn: object, cursor: object, statement: str, *args: object) -> None:
        statements.append(statement)

    fresh_session = async_sessionmaker(engine)
    event.listen(engine.sync_engine, "before_cursor_execute", before)
    try:
        async with fresh_session() as session:
            careers = await MatchDetailsRepository(session).career_before(
                user_ids, datetime.now(UTC)
            )
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", before)

    assert len(statements) == 1, statements
    assert list(careers) == user_ids


async def test_career_before_defaults_a_zero_history_player_to_zero(
    api_client: AsyncClient, db_session: AsyncSession
):
    """A player with no completed matches has *no row* in the batched
    ``GROUP BY user_id`` result. They must be defaulted back in as a 0/0 record —
    not dropped from the dict (which would silently strip them from recent_form)
    and not a ``KeyError``."""
    me = await start_session(api_client, db_session)
    async with opponent_session(db_session, "career-zero-opp") as (opp_client, opp):
        await _play_match_to_completion(
            api_client, opp_client, opp.id, best_of=3, side_1_wins=True
        )
    newcomer = await make_user(db_session, "career-zero-newcomer")

    careers = await MatchDetailsRepository(db_session).career_before(
        [me.id, opp.id, newcomer.id], datetime.now(UTC) + timedelta(days=1)
    )

    # Present, not missing — the whole trap of batching this loader.
    assert newcomer.id in careers
    assert careers[newcomer.id] == CareerRecord(matches=0, wins=0)
    # And the players who *do* have history keep their real numbers.
    assert careers[me.id] == CareerRecord(matches=1, wins=1)
    assert careers[opp.id] == CareerRecord(matches=1, wins=0)


def _standalone_rating_row(
    league: League,
    user: User,
    strategy: RatingStrategy,
    value: float,
    created_at: datetime,
) -> RatingHistory:
    """A match-less rating row at a chosen instant. ``match_id`` stays ``None`` so
    the partial unique index on ``(match_id, user_id)`` doesn't cap a player at one
    row — these tests need a player to carry more than the sparkline limit."""
    return RatingHistory(
        league_id=league.id,
        user_id=user.id,
        match_id=None,
        rating_strategy_id=strategy.id,
        rating_value=value,
        rating_state={"rating": value, "rd": 350.0, "volatility": 0.06},
        source=RatingHistorySource.manual,
        created_at=created_at,
    )


async def test_pre_match_ratings_batches_every_user_into_one_statement(
    db_session: AsyncSession,
    engine: AsyncEngine,
    default_league: League,
    rating_strategies: dict[str, RatingStrategy],
):
    """The pre-match rating + sparkline for N players costs one SQL statement,
    not N (#195).

    Three ids on purpose: a reintroduced per-user loop emits three statements and
    fails loudly here, where a two-id list could still be read as a coincidence.
    The counter runs on its own fresh ``async_sessionmaker`` session so the setup
    INSERTs (already committed on ``db_session``) can't inflate the count, and so
    the shared session's identity map / pending flushes can't mask a query.
    """
    users = [await make_user(db_session, f"rating-batch-{n}") for n in range(3)]
    user_ids = [user.id for user in users]
    for n, user in enumerate(users):
        db_session.add(
            _standalone_rating_row(
                default_league,
                user,
                rating_strategies["glicko2"],
                value=1500.0 + n,
                created_at=datetime(2026, 5, 1, tzinfo=UTC),
            )
        )
    await db_session.commit()

    statements: list[str] = []

    def before(conn: object, cursor: object, statement: str, *args: object) -> None:
        statements.append(statement)

    fresh_session = async_sessionmaker(engine)
    event.listen(engine.sync_engine, "before_cursor_execute", before)
    try:
        async with fresh_session() as session:
            ratings = await MatchDetailsRepository(session).pre_match_ratings(
                user_ids, default_league.id, datetime.now(UTC)
            )
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", before)

    assert len(statements) == 1, statements
    assert list(ratings) == user_ids
    assert [ratings[user_id].value for user_id in user_ids] == [1500.0, 1501.0, 1502.0]


async def test_pre_match_ratings_defaults_a_never_rated_player_to_null(
    api_client: AsyncClient,
    db_session: AsyncSession,
    default_league: League,
):
    """A player with no rating history has *no rows* in the batched window
    result. They must be defaulted back in as an unrated player — a present key
    holding ``value=None, history=[]``, not a dropped key (which would silently
    strip them from recent_form) and not a ``KeyError``."""
    me = await start_session(api_client, db_session)
    newcomer = await make_user(db_session, "rating-null-newcomer")

    ratings = await MatchDetailsRepository(db_session).pre_match_ratings(
        [me.id, newcomer.id],
        default_league.id,
        datetime.now(UTC) + timedelta(days=1),
    )

    # Present, not missing — the whole trap of batching this loader.
    assert newcomer.id in ratings
    assert ratings[newcomer.id] == PreMatchRating(value=None, history=[])
    # And the player who *does* have history keeps their league-join seed.
    assert ratings[me.id] == PreMatchRating(value=1500.0, history=[1500.0])


async def test_pre_match_ratings_caps_the_sparkline_per_user(
    db_session: AsyncSession,
    default_league: League,
    rating_strategies: dict[str, RatingStrategy],
):
    """The 10-row cap is per *player*, not a flat cap on the batched result set:
    a naive ``LIMIT 10`` over the whole window would hand all ten rows to the
    first player and starve the second."""
    strategy = rating_strategies["glicko2"]
    a = await make_user(db_session, "rating-cap-a")
    b = await make_user(db_session, "rating-cap-b")
    base = datetime(2026, 5, 1, tzinfo=UTC)
    for n in range(RATING_HISTORY_LIMIT + 2):
        at = base + timedelta(minutes=n)
        db_session.add(
            _standalone_rating_row(default_league, a, strategy, 1000.0 + n, at)
        )
        db_session.add(
            _standalone_rating_row(default_league, b, strategy, 2000.0 + n, at)
        )
    await db_session.commit()

    ratings = await MatchDetailsRepository(db_session).pre_match_ratings(
        [a.id, b.id], default_league.id, base + timedelta(days=1)
    )

    # Twelve rows each, ten kept each: the newest ten, oldest-first, with
    # ``value`` the most recent of them.
    assert ratings[a.id] == PreMatchRating(
        value=1011.0, history=[1000.0 + n for n in range(2, 12)]
    )
    assert ratings[b.id] == PreMatchRating(
        value=2011.0, history=[2000.0 + n for n in range(2, 12)]
    )


async def test_pre_match_ratings_ignores_other_leagues(
    db_session: AsyncSession,
    default_league: League,
    rating_strategies: dict[str, RatingStrategy],
):
    """The sparkline is scoped to *this match's* league. A player rated in a
    second league must not have that league's ratings bleed into the trail shown
    on a match played in the default league.

    The other-league row is deliberately the player's *newest*, so dropping the
    ``RatingHistory.league_id == league_id`` filter doesn't merely lengthen the
    history — it also hijacks ``value`` — and this test goes red on both counts.
    """
    strategy = rating_strategies["glicko2"]
    other_league = League(
        name="Other League",
        description="A league this match is not played in.",
        visibility=LeagueVisibility.public,
        is_default=False,
        rating_strategy_id=strategy.id,
    )
    db_session.add(other_league)
    await db_session.commit()

    player = await make_user(db_session, "cross-league-player")
    base = datetime(2026, 5, 1, tzinfo=UTC)
    db_session.add(
        _standalone_rating_row(default_league, player, strategy, 1500.0, base)
    )
    db_session.add(
        _standalone_rating_row(
            other_league, player, strategy, 1900.0, base + timedelta(minutes=1)
        )
    )
    await db_session.commit()

    ratings = await MatchDetailsRepository(db_session).pre_match_ratings(
        [player.id], default_league.id, base + timedelta(days=1)
    )

    # Only the default league's row exists as far as this match is concerned.
    assert ratings[player.id] == PreMatchRating(value=1500.0, history=[1500.0])


async def test_pre_match_ratings_excludes_a_row_stamped_at_the_cutoff(
    db_session: AsyncSession,
    default_league: League,
    rating_strategies: dict[str, RatingStrategy],
):
    """``before`` is an exclusive bound: a rating row stamped at *exactly* the
    cutoff instant is not part of the "before" trail.

    That strictness is what keeps a match's own rating row out of its own
    pre-match sparkline — the trail must show what the player carried *into* the
    match, never what the match itself did to them. Relaxing ``created_at <
    before`` to ``<=`` lets the cutoff row in as the newest entry, hijacking both
    ``value`` and ``history``, and fails this test.
    """
    strategy = rating_strategies["glicko2"]
    player = await make_user(db_session, "cutoff-player")
    # One shared literal for the cutoff and the row stamped on it: two calls to
    # now() would differ by microseconds and the boundary would never be tested.
    cutoff = datetime(2026, 5, 1, 12, 0, tzinfo=UTC)
    db_session.add(
        _standalone_rating_row(
            default_league, player, strategy, 1500.0, cutoff - timedelta(minutes=1)
        )
    )
    db_session.add(
        _standalone_rating_row(default_league, player, strategy, 1650.0, cutoff)
    )
    await db_session.commit()

    ratings = await MatchDetailsRepository(db_session).pre_match_ratings(
        [player.id], default_league.id, cutoff
    )

    # The row *at* the cutoff is excluded; only the strictly-earlier one survives.
    assert ratings[player.id] == PreMatchRating(value=1500.0, history=[1500.0])


# The whole view-extras block for a completed singles match, pinned. The terms:
#
#   1  rating_changes    — the match's own rating rows
#   1  career_before     — batched: one GROUP BY user_id covering both users
#   1  pre_match_ratings — batched: one ROW_NUMBER() window covering both users
#   2  recent_form       — the form-rows query, once per user (see below)
#   1  head_to_head      — the prior-meetings rows
#   1  head_to_head      — the prior-meetings counts aggregate
#   = 7
#
# The form-rows query is the one term that intentionally scales with player count
# (ADR 0015: batching it is 2 queries → 2 queries at N=2, so it stays per-user).
# Everything else is constant. The fixture is a single completed match with no
# prior history for either player, so the history windows come back empty and the
# ``selectinload`` chains on the form-rows / H2H-rows queries emit nothing — the
# count stays a measure of *round-trips through the extras loaders*, not of the
# eager-load options hung off them.
EXPECTED_VIEW_EXTRAS_STATEMENTS = 7


async def test_view_extras_issues_a_pinned_number_of_statements(
    api_client: AsyncClient, db_session: AsyncSession, engine: AsyncEngine
):
    """Loading the extras for a completed singles match costs a pinned, constant
    number of SQL statements (#195).

    This is the tripwire the per-loader batching tests can't be. They prove each
    *loader* emits one statement per call — but they'd still pass if someone moved
    ``career_before`` or ``pre_match_ratings`` back *inside* ``recent_form``'s
    per-user loop: the loader would keep emitting exactly one statement, just N
    times over. Only a total count around the whole block catches that, and this
    test is written so that regression fails it — the count rises above the pin.

    Counting is scoped to ``load_view_extras`` rather than the HTTP request on
    purpose: an endpoint-level count would also sweep up session / auth /
    rate-limit statements and go red for reasons that have nothing to do with the
    N+1. The counter runs on a fresh ``async_sessionmaker`` session so the setup's
    committed writes and the shared session's identity map can't skew the count.
    """
    me = await start_session(api_client, db_session)
    async with opponent_session(db_session, "roundtrip-opp") as (opp_client, opp):
        finished = await _play_match_to_completion(
            api_client, opp_client, opp.id, best_of=3, side_1_wins=True
        )
    match = (
        await db_session.execute(
            select(Match).where(Match.id == uuid.UUID(finished["id"]))
        )
    ).scalar_one()

    statements: list[str] = []

    def before(conn: object, cursor: object, statement: str, *args: object) -> None:
        statements.append(statement)

    fresh_session = async_sessionmaker(engine)
    event.listen(engine.sync_engine, "before_cursor_execute", before)
    try:
        async with fresh_session() as session:
            extras = await _match_service(session).load_view_extras(
                match_id=match.id,
                league_id=match.league_id,
                status=match.status,
                created_at=match.created_at,
                user_ids=[me.id, opp.id],
            )
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", before)

    for n, statement in enumerate(statements, start=1):
        print(f"[{n}] {' '.join(statement.split())}")

    assert len(statements) == EXPECTED_VIEW_EXTRAS_STATEMENTS, statements
    # And the block it counted is the real one, fully populated.
    assert {form.user_id for form in extras.recent_form} == {me.id, opp.id}
    assert set(extras.rating_changes) == {me.id, opp.id}
    assert extras.head_to_head is not None


async def test_list_matches_csv_export(
    api_client: AsyncClient, db_session: AsyncSession
):
    me = await start_session(api_client, db_session)
    opp = await make_user(db_session, "csv-rival")
    created = await _create_match(api_client, opp.id, best_of=5)

    response = await api_client.get("/v1/matches.csv")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/csv")
    assert "attachment; filename=" in response.headers["content-disposition"]
    lines = response.text.strip().splitlines()
    assert lines[0] == "Match ID,Created,Status,League,Side 1,Side 2,Score,Best of"
    # One data row for the one match, carrying both players + best_of.
    assert len(lines) == 2
    assert created["id"] in lines[1]
    assert me.username in lines[1]
    assert opp.username in lines[1]
    assert lines[1].endswith(",5")  # best_of; score blank while pending


async def test_list_matches_csv_includes_score_for_completed(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    async with opponent_session(db_session, "csv-finished") as (opp_client, opp):
        await _play_match_to_completion(
            api_client, opp_client, opp.id, best_of=3, side_1_wins=True
        )

    response = await api_client.get("/v1/matches.csv")

    lines = response.text.strip().splitlines()
    assert len(lines) == 2
    # Best-of-3 won 2-0 by side 1 → score column populated.
    assert lines[1].endswith(",2-0,3")


async def test_list_matches_csv_honors_status_filter(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    opp = await make_user(db_session, "csv-filter")
    await _create_match(api_client, opp.id)  # pending

    response = await api_client.get("/v1/matches.csv?status=completed")

    # Header only — the pending match is filtered out.
    assert response.status_code == 200
    assert response.text.strip().splitlines() == [
        "Match ID,Created,Status,League,Side 1,Side 2,Score,Best of"
    ]


# ----- accept flow (POST /results/{id}/acceptance) + scratchpad freeze ----


async def _post_results(client: AsyncClient, match_id: str, best_of: int = 3) -> dict:
    """Caller wins the minimum games needed to clinch a best-of-N. Returns
    the propose response body."""
    needed = best_of // 2 + 1
    response = await client.post(
        f"/v1/matches/{match_id}/results",
        json={
            "games": [
                {"game_number": n, "side_1_points": 11, "side_2_points": 4}
                for n in range(1, needed + 1)
            ]
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


async def test_accept_finalizes_and_applies_ratings_once(
    api_client: AsyncClient, db_session: AsyncSession
):
    """Accepting a standing proposal completes the match, stamps ``side.won``
    from the agreed board, marks the result accepted, and applies the rating
    update — exactly once. A second acceptance on the now-completed match 409s
    and never re-runs ratings."""
    me = await start_session(api_client, db_session)
    async with opponent_session(db_session, "accept-opp") as (opp_client, opp):
        match = await _create_match(api_client, opp.id, best_of=3)
        await _post_results(api_client, match["id"])

        body = await accept_standing_result(opp_client, match["id"])
        assert body["status"] == "completed"
        assert body["status_label"] == "Final"
        # The negotiation block reads ``final`` once a result is accepted.
        neg = body["negotiation"]
        assert neg["viewer_state"] == "final"
        assert neg["your_turn"] is False
        assert neg["prior_result"] is None
        assert neg["diff"] is None
        sides = sorted(body["sides"], key=lambda s: s["side_number"])
        assert [s["won"] for s in sides] == [True, False]

        # The accepted result records the acceptor; ratings applied once.
        result = (
            await db_session.execute(
                select(MatchResult).where(
                    MatchResult.match_id == uuid.UUID(match["id"])
                )
            )
        ).scalar_one()
        assert result.accepted_by_user_id == opp.id
        assert result.accepted_at is not None
        rating_rows = (
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
        assert len(rating_rows) == 2
        assert {r.user_id for r in rating_rows} == {me.id, opp.id}

        # A second acceptance on the completed match is a clean 409. In the
        # ``final`` state the negotiation's ``standing_result`` surfaces the
        # accepted (agreed) board so the FE can render it — but it's no longer a
        # live proposal, and ratings are not re-applied.
        details = (await opp_client.get(f"/v1/matches/{match['id']}")).json()
        assert details["negotiation"]["viewer_state"] == "final"
        assert details["negotiation"]["standing_result"]["id"] == str(result.id)
        again = await opp_client.post(
            f"/v1/matches/{match['id']}/results/{result.id}/acceptance"
        )
        assert again.status_code == 409
        rating_rows_after = (
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
        assert len(rating_rows_after) == 2


async def test_accept_superseded_result_id_is_409(
    api_client: AsyncClient, db_session: AsyncSession
):
    """``result_id`` is the concurrency token: accepting a proposal that has
    since been superseded by a counter 409s with the moved-on state — only the
    live standing proposal can be accepted."""
    await start_session(api_client, db_session)
    async with opponent_session(db_session, "accept-stale-opp") as (opp_client, opp):
        match = await _create_match(api_client, opp.id, best_of=1)
        first = await _propose(api_client, match["id"], s1=11, s2=4)
        first_id = first["body"]["negotiation"]["standing_result"]["id"]

        # The opponent counters, superseding the first proposal.
        counter = await _propose(
            opp_client, match["id"], s1=4, s2=11, supersedes=first_id
        )
        assert counter["status"] == 201
        counter_id = counter["body"]["negotiation"]["standing_result"]["id"]

        # The proposer tries to accept the now-superseded first proposal.
        stale = await api_client.post(
            f"/v1/matches/{match['id']}/results/{first_id}/acceptance"
        )
        assert stale.status_code == 409
        # The 409 carries the moved-on negotiation state (the counter standing).
        assert stale.json()["detail"]["standing_result"]["id"] == counter_id


async def test_accept_unknown_result_id_is_404(
    api_client: AsyncClient, db_session: AsyncSession
):
    """A ``result_id`` that doesn't exist on the match at all is a 404, distinct
    from the superseded/already-accepted 409."""
    await start_session(api_client, db_session)
    async with opponent_session(db_session, "accept-404-opp") as (opp_client, opp):
        match = await _create_match(api_client, opp.id, best_of=1)
        await _post_results(api_client, match["id"], best_of=1)
        ghost = uuid.uuid4()
        resp = await opp_client.post(
            f"/v1/matches/{match['id']}/results/{ghost}/acceptance"
        )
        assert resp.status_code == 404


async def test_proposer_cannot_accept_own_proposal(
    api_client: AsyncClient, db_session: AsyncSession
):
    """The proposing side already consented by proposing; only the opposing side
    accepts. A participant on the submitter's side gets a 409 — they can't ratify
    their own claim."""
    await start_session(api_client, db_session)
    async with opponent_session(db_session, "self-accept-opp") as (_opp_client, opp):
        match = await _create_match(api_client, opp.id, best_of=1)
        posted = await _post_results(api_client, match["id"], best_of=1)
        result_id = posted["negotiation"]["standing_result"]["id"]

        self_accept = await api_client.post(
            f"/v1/matches/{match['id']}/results/{result_id}/acceptance"
        )
        assert self_accept.status_code == 409
        assert "your own proposal" in self_accept.json()["detail"]


async def test_accept_404_for_non_participant(
    api_client: AsyncClient, db_session: AsyncSession
):
    """A non-participant can't accept — they get a 404, mirroring the other
    write paths (no way to learn the match exists)."""
    await start_session(api_client, db_session)
    async with opponent_session(db_session, "accept-np-opp") as (_opp_client, opp):
        match = await _create_match(api_client, opp.id, best_of=1)
        posted = await _post_results(api_client, match["id"], best_of=1)
        result_id = posted["negotiation"]["standing_result"]["id"]
        async with make_client() as bystander_client:
            await start_session(bystander_client, db_session)
            resp = await bystander_client.post(
                f"/v1/matches/{match['id']}/results/{result_id}/acceptance"
            )
            assert resp.status_code == 404


async def test_non_participant_cannot_counter_standing_result(
    api_client: AsyncClient, db_session: AsyncSession
):
    """Contesting/correcting a standing result is a counter-proposal
    (``POST /results`` with ``supersedes_result_id``). A non-participant can't
    counter — they're 404'd at the participation gate before the supersedes
    logic runs, same as every other write path (no way to learn the match
    exists). Server-side counterpart to hiding the callout from spectators
    (#846 web, #836 iOS)."""
    await start_session(api_client, db_session)
    async with opponent_session(db_session, "counter-np-opp") as (_opp_client, opp):
        match = await _create_match(api_client, opp.id, best_of=1)
        posted = await _post_results(api_client, match["id"], best_of=1)
        result_id = posted["negotiation"]["standing_result"]["id"]
        async with make_client() as bystander_client:
            await start_session(bystander_client, db_session)
            counter = await _propose(
                bystander_client, match["id"], s1=4, s2=11, supersedes=result_id
            )
            assert counter["status"] == 404, counter


async def test_accept_409_when_no_result_posted(
    api_client: AsyncClient, db_session: AsyncSession
):
    """With no proposal on the table there's nothing to accept — any
    ``result_id`` is unknown (404)."""
    await start_session(api_client, db_session)
    async with opponent_session(db_session, "accept-early-opp") as (opp_client, opp):
        match = await _create_match(api_client, opp.id, best_of=3)
        resp = await opp_client.post(
            f"/v1/matches/{match['id']}/results/{uuid.uuid4()}/acceptance"
        )
        assert resp.status_code == 404


async def test_scratchpad_freezes_on_first_proposal(
    api_client: AsyncClient, db_session: AsyncSession
):
    """The scratchpad is editable until the first proposal, then frozen (#715):
    once a result exists, every per-game write 409s with the frozen-scores
    message, regardless of whether the result is later accepted."""
    await start_session(api_client, db_session)
    async with opponent_session(db_session, "freeze-opp") as (_opp_client, opp):
        match = await _create_match(api_client, opp.id, best_of=3)
        # Pre-proposal: scratchpad accepts a score.
        first = await api_client.post(
            f"/v1/matches/{match['id']}/games/1/scores/new",
            json={"side_1_points": 11, "side_2_points": 4},
        )
        assert first.status_code == 201
        assert first.json()["can_score"] is True

        await _post_results(api_client, match["id"])

        # Post-proposal: every write path 409s with the freeze message.
        post = await api_client.post(
            f"/v1/matches/{match['id']}/games/2/scores/new",
            json={"side_1_points": 11, "side_2_points": 7},
        )
        assert post.status_code == 409
        assert "frozen" in post.json()["detail"]


async def test_either_participant_can_edit_before_first_proposal(
    api_client: AsyncClient, db_session: AsyncSession
):
    """Pre-first-proposal the working board is a shared scratchpad: *either*
    participant may edit it (the score endpoints gate on participation, not the
    creator). Both the creator and the opponent can create + update scores."""
    await start_session(api_client, db_session)
    async with opponent_session(db_session, "shared-scratchpad-opp") as (
        opp_client,
        opp,
    ):
        match = await _create_match(api_client, opp.id, best_of=3)

        # The creator enters game 1.
        created = await api_client.post(
            f"/v1/matches/{match['id']}/games/1/scores/new",
            json={"side_1_points": 11, "side_2_points": 4},
        )
        assert created.status_code == 201
        assert created.json()["can_score"] is True

        # The opponent enters game 2 on the same scratchpad.
        opp_created = await opp_client.post(
            f"/v1/matches/{match['id']}/games/2/scores/new",
            json={"side_1_points": 7, "side_2_points": 11},
        )
        assert opp_created.status_code == 201
        # ...and the opponent can also overwrite the creator's game 1.
        opp_edit = await opp_client.put(
            f"/v1/matches/{match['id']}/games/1/scores",
            json={"side_1_points": 9, "side_2_points": 11, "expected_version": 1},
        )
        assert opp_edit.status_code == 200


async def test_results_on_solo_finalizes_with_no_acceptor_round_trip(
    api_client: AsyncClient, db_session: AsyncSession
):
    """Solo matches (no opponent picked) keep today's auto-finalize behavior
    on propose — there's no second party to accept, so the proposer self-accepts
    and the match flips straight to completed."""
    await start_session(api_client, db_session)
    match = (
        await api_client.post("/v1/matches", json={"best_of": 1, "rated": False})
    ).json()
    body = await _post_results(api_client, match["id"], best_of=1)
    assert body["status"] == "completed"
    assert body["negotiation"]["viewer_state"] == "final"


async def test_results_on_unrated_match_finalizes_immediately(
    api_client: AsyncClient, db_session: AsyncSession
):
    """An unrated match with a real opponent skips the accept round-trip (#485):
    acceptance exists to protect ratings from one-sided claims, and an unrated
    match has no stakes worth a second acceptance. The propose call flips straight
    to completed, stamps ``side.won``, and self-accepts — same as the solo
    path."""
    await start_session(api_client, db_session)
    async with opponent_session(db_session, "casual-opp") as (opp_client, opp):
        create = await api_client.post(
            "/v1/matches",
            json={"opponent_user_id": str(opp.id), "best_of": 3, "rated": False},
        )
        assert create.status_code == 201
        match = create.json()

        body = await _post_results(api_client, match["id"])
        assert body["status"] == "completed"
        assert body["status_label"] == "Final"
        assert body["negotiation"]["viewer_state"] == "final"
        sides = sorted(body["sides"], key=lambda s: s["side_number"])
        assert [s["won"] for s in sides] == [True, False]
        assert [s["rating_change"] for s in sides] == [None, None]

        # Nothing left to accept — the match is final from the opponent's view
        # too (the negotiation surfaces the agreed board, not a live proposal).
        details = (await opp_client.get(f"/v1/matches/{match['id']}")).json()
        assert details["negotiation"]["viewer_state"] == "final"
        assert details["negotiation"]["your_turn"] is False


async def test_standing_proposal_keeps_scores_public_but_not_won(
    api_client: AsyncClient, db_session: AsyncSession
):
    """Locks the awaiting-confirmation read contract for both the authed detail
    endpoint AND the anonymous public read path. From the moment the proposal
    lands, ``games[].score`` and the games-won counts are visible — the opponent
    (and any third party) needs to see what's being claimed. But ``side.won``
    stays null until acceptance ratifies the result (#485): no official W/L
    before the opposing side accepts. The spectator's neutral negotiation view
    reads ``review`` with no actions."""
    await start_session(api_client, db_session)
    async with opponent_session(db_session, "shape-opp") as (_opp_client, opp):
        match = await _create_match(api_client, opp.id, best_of=3)
        await _post_results(api_client, match["id"])

        # Authed read (proposer's perspective).
        authed = (await api_client.get(f"/v1/matches/{match['id']}")).json()
        assert authed["status"] == "in_progress"
        assert authed["status_label"] == "Awaiting acceptance"
        sides = sorted(authed["sides"], key=lambda s: s["side_number"])
        assert [s["won"] for s in sides] == [None, None]
        assert [s["games_won"] for s in sides] == [2, 0]
        # Per-game scores stay visible — the opponent (and any third party)
        # needs to see what's being claimed.
        for g in sorted(authed["games"], key=lambda g: g["game_number"]):
            assert g["score"] is not None
            assert g["score"]["side_1_points"] > 0
        # The proposer is awaiting the opponent.
        assert authed["negotiation"]["viewer_state"] == "awaiting"

        # Anonymous read (public share route via the same endpoint).
        async with make_client() as anon:
            anon_view = (await anon.get(f"/v1/matches/{match['id']}")).json()
        assert anon_view["status"] == "in_progress"
        assert anon_view["status_label"] == "Awaiting acceptance"
        anon_sides = sorted(anon_view["sides"], key=lambda s: s["side_number"])
        assert [s["won"] for s in anon_sides] == [None, None]
        for g in sorted(anon_view["games"], key=lambda g: g["game_number"]):
            assert g["score"] is not None
        # Spectator's neutral negotiation view: there is a standing proposal but
        # they have no side, so it's a read-only ``review`` with no actions.
        anon_neg = anon_view["negotiation"]
        assert anon_neg["viewer_state"] == "review"
        assert anon_neg["your_turn"] is False
        assert anon_neg["diff"] is None
        assert anon_neg["prior_result"] is None
        # No write affordances for the spectator.
        assert anon_view["can_score"] is False
        assert anon_view["can_finalize"] is False


async def test_list_status_label_reflects_awaiting_acceptance(
    api_client: AsyncClient, db_session: AsyncSession
):
    """A list row for a match with a standing (unaccepted) result shows the
    ``Awaiting acceptance`` label, even though ``status`` remains
    ``in_progress`` — the FE renders the label directly."""
    await start_session(api_client, db_session)
    async with opponent_session(db_session, "list-label-opp") as (_opp_client, opp):
        match = await _create_match(api_client, opp.id, best_of=3)
        await _post_results(api_client, match["id"])

    listing = (await api_client.get("/v1/matches")).json()
    row = next(r for r in listing["items"] if r["id"] == match["id"])
    assert row["status"] == "in_progress"
    assert row["status_label"] == "Awaiting acceptance"


async def test_list_row_negotiation_reflects_whose_turn(
    api_client: AsyncClient, db_session: AsyncSession
):
    """The matches list carries the same viewer-relative ``negotiation`` block
    as the details endpoint, so the FE can pick the row CTA without re-deriving
    acceptance state. The proposer's row reads ``awaiting`` (not their turn); the
    opposing side's row reads ``review`` (their turn)."""
    await start_session(api_client, db_session)
    async with opponent_session(db_session, "list-neg-opp") as (opp_client, opp):
        match = await _create_match(api_client, opp.id, best_of=3)
        await _post_results(api_client, match["id"])

        my_list = (await api_client.get("/v1/matches")).json()
        my_row = next(r for r in my_list["items"] if r["id"] == match["id"])
        assert my_row["negotiation"]["viewer_state"] == "awaiting"
        assert my_row["negotiation"]["your_turn"] is False

        opp_list = (await opp_client.get("/v1/matches")).json()
        opp_row = next(r for r in opp_list["items"] if r["id"] == match["id"])
        assert opp_row["negotiation"]["viewer_state"] == "review"
        assert opp_row["negotiation"]["your_turn"] is True


async def test_concurrent_accept_and_counter_serialize(
    api_client: AsyncClient, db_session: AsyncSession, engine: AsyncEngine
):
    """The opposing side firing an acceptance while the proposing side fires a
    counter at the same instant must not corrupt the match. The row lock in
    ``_load_match_for_scoring(..., lock=True)`` serializes them: exactly one
    transition wins on the standing result, the other re-reads the committed
    post-image and 409s, and the match invariants always hold.

    Drives the two handlers on *separate* DB sessions via ``asyncio.gather`` so
    the ``FOR UPDATE`` actually blocks — the shared ``db_session`` override can't
    surface the race.
    """
    me = await start_session(api_client, db_session)
    async with opponent_session(db_session, "race-opp") as (opp_client, opp):
        # Rated best-of-1: the OPPONENT proposes (via their own committed HTTP
        # call), leaving ME owing a review. Capture the standing result id.
        match = await _create_match(api_client, opp.id, best_of=1)
        match_id = uuid.UUID(match["id"])
        me_id, opp_id = me.id, opp.id
        posted = await _post_results(opp_client, match["id"], best_of=1)
        standing_id = uuid.UUID(posted["negotiation"]["standing_result"]["id"])

        make_session = async_sessionmaker(engine, expire_on_commit=False)

        async def accept() -> object:
            async with make_session() as session:
                actor = (
                    await session.execute(select(User).where(User.id == me_id))
                ).scalar_one()
                try:
                    await accept_match_result(
                        match_id, standing_id, actor, session, _match_service(session)
                    )
                    return "ok-accept"
                except HTTPException as exc:
                    return exc.status_code

        async def counter() -> object:
            async with make_session() as session:
                actor = (
                    await session.execute(select(User).where(User.id == opp_id))
                ).scalar_one()
                notifications = NotificationService(session, FakeSender())
                payload = MatchResultsWrite(
                    games=[
                        MatchResultsGameWrite(
                            game_number=1, side_1_points=4, side_2_points=11
                        )
                    ],
                    supersedes_result_id=standing_id,
                )
                try:
                    await post_match_result(
                        match_id,
                        payload,
                        actor,
                        session,
                        _match_service(session),
                        notifications,
                    )
                    return "ok-counter"
                except HTTPException as exc:
                    return exc.status_code

        outcomes = await asyncio.gather(accept(), counter())
        # Exactly one transition wins on the standing result; the other is a
        # clean 409. (Either the accept lands first — the counter then 409s
        # because the standing result is accepted — or the counter lands first
        # and the accept 409s because its target was superseded.)
        oks = [o for o in outcomes if isinstance(o, str)]
        rejects = [o for o in outcomes if o == 409]
        assert len(oks) == 1 and len(rejects) == 1, outcomes

        async with make_session() as verify:
            final = (
                await verify.execute(
                    select(Match)
                    .where(Match.id == match_id)
                    .options(selectinload(Match.sides), selectinload(Match.results))
                )
            ).scalar_one()
            sides = sorted(final.sides, key=lambda s: s.side_number)
            accepted = [r for r in final.results if r.accepted_by_user_id is not None]
            if final.status == MatchStatus.completed:
                # Accept won: exactly one result accepted, real outcome stamped.
                assert len(accepted) == 1
                assert {s.won for s in sides} == {True, False}
            else:
                # Counter won: the match is still in_progress with a new standing
                # proposal and no accepted result yet.
                assert final.status == MatchStatus.in_progress
                assert accepted == []
                assert len(final.results) == 2


# ----- result-confirmation delivery (enqueued to the worker) --------------


async def test_posting_result_enqueues_confirmation_for_opponent(
    api_client: AsyncClient,
    db_session: AsyncSession,
    fake_notifications_queue: Queue,
):
    """Posting a result on a two-human match enqueues one accept/counter
    delivery for the opponent — filed under the result-confirmation category,
    deep-linked to the match, carrying the result-confirmation push category +
    match id, with recipient-framed copy. The poster gets nothing."""
    me = await start_session(api_client, db_session)
    me.username = "poster"
    await db_session.commit()

    async with opponent_session(db_session, "rival") as (_opp_client, opp):
        match = await _create_match(api_client, opp.id, best_of=3)
        response = await api_client.post(
            f"/v1/matches/{match['id']}/results",
            json={
                "games": [
                    {"game_number": 1, "side_1_points": 11, "side_2_points": 7},
                    {"game_number": 2, "side_1_points": 9, "side_2_points": 11},
                    {"game_number": 3, "side_1_points": 11, "side_2_points": 8},
                ]
            },
        )
        assert response.status_code == 201
        standing_result_id = response.json()["negotiation"]["standing_result"]["id"]

    jobs = enqueued_notification_jobs(fake_notifications_queue)
    assert [job.user_id for job in jobs] == [opp.id]
    job = jobs[0]
    assert job.category.value == "result_confirm"
    assert job.link == f"/matches/{match['id']}"
    assert job.push_category == MATCH_RESULT_CONFIRMATION_CATEGORY
    # The push carries the specific result it's about (so the client can route
    # to it) and a per-match collapse id (so a superseding confirmation replaces
    # the stale banner rather than stacking).
    assert job.push_data == {
        "match_id": match["id"],
        "result_id": standing_result_id,
    }
    assert job.collapse_id == f"result-confirm:{match['id']}"
    # Propose/accept vocabulary, not the retired confirm/dispute model (#728).
    # A first post's recipient sees Accept/Suggest-correction buttons (not
    # Accept/Counter — that pair is reserved for the corrected-result case).
    assert job.title == "Accept your match result"
    assert "Accept or suggest a correction?" in job.body
    assert "dispute" not in job.body.lower()
    # Recipient-framed games-won (poster won 2–1) and the per-game scores.
    assert "poster reported beating you 2–1" in job.body
    assert "11–7" in job.body
    assert "9–11" in job.body
    assert "11–8" in job.body


async def test_posting_losing_result_enqueues_confirmation_for_opponent(
    api_client: AsyncClient,
    db_session: AsyncSession,
    fake_notifications_queue: Queue,
):
    """When the poster reports that they lost, the recipient-framed copy
    reads grammatically ("losing to you"), not "reported losing you"."""
    me = await start_session(api_client, db_session)
    me.username = "poster"
    await db_session.commit()

    async with opponent_session(db_session, "rival") as (_opp_client, opp):
        match = await _create_match(api_client, opp.id, best_of=3)
        response = await api_client.post(
            f"/v1/matches/{match['id']}/results",
            json={
                "games": [
                    {"game_number": 1, "side_1_points": 7, "side_2_points": 11},
                    {"game_number": 2, "side_1_points": 9, "side_2_points": 11},
                ]
            },
        )
        assert response.status_code == 201

    jobs = enqueued_notification_jobs(fake_notifications_queue)
    assert [job.user_id for job in jobs] == [opp.id]
    job = jobs[0]
    # Recipient-framed games-won (poster lost 0–2), phrased grammatically.
    assert "poster reported losing to you 2–0" in job.body


async def test_posting_counter_enqueues_confirmation_with_counter_prompt(
    api_client: AsyncClient,
    db_session: AsyncSession,
    fake_notifications_queue: Queue,
):
    """Countering a standing result (``supersedes_result_id`` set) prompts the
    recipient with "Accept or counter?" — the Accept/Counter button pair the
    corrected-result callout actually renders — not the first-post's
    Accept/Suggest-correction prompt (#728)."""
    me = await start_session(api_client, db_session)
    me.username = "proposer"
    await db_session.commit()

    async with opponent_session(db_session, "counterer") as (opp_client, opp):
        match = await _create_match(api_client, opp.id, best_of=1)
        first = await _propose(api_client, match["id"], s1=11, s2=4)
        assert first["status"] == 201
        first_id = first["body"]["negotiation"]["standing_result"]["id"]

        counter = await _propose(
            opp_client, match["id"], s1=4, s2=11, supersedes=first_id
        )
        assert counter["status"] == 201, counter

    jobs = enqueued_notification_jobs(fake_notifications_queue)
    # The first post notifies the opponent; the counter notifies me back.
    assert [job.user_id for job in jobs] == [opp.id, me.id]
    counter_job = jobs[1]
    assert "Accept or counter?" in counter_job.body
    assert "suggest a correction" not in counter_job.body.lower()


async def test_posting_self_edit_enqueues_first_post_prompt_not_counter(
    api_client: AsyncClient,
    db_session: AsyncSession,
    fake_notifications_queue: Queue,
):
    """A proposer correcting their own still-standing proposal (before the
    opponent ever answers) sets ``supersedes_result_id``, but the opponent's
    view stays the first-post ``review`` state (mirrors
    ``test_propose_self_edit_chain_supersedes_own_proposal``) — so the
    re-sent notification must keep the Accept/Suggest-correction prompt, not
    switch to "Accept or counter?" just because a result was superseded."""
    me = await start_session(api_client, db_session)
    me.username = "proposer"
    await db_session.commit()

    async with opponent_session(db_session, "rival") as (_opp_client, opp):
        match = await _create_match(api_client, opp.id, best_of=1)
        first = await _propose(api_client, match["id"], s1=11, s2=4)
        assert first["status"] == 201
        first_id = first["body"]["negotiation"]["standing_result"]["id"]

        # Same proposer corrects their own board before the opponent responds.
        second = await _propose(
            api_client, match["id"], s1=11, s2=9, supersedes=first_id
        )
        assert second["status"] == 201, second

    jobs = enqueued_notification_jobs(fake_notifications_queue)
    # Both the first post and the self-edit notify the opponent (never me).
    assert [job.user_id for job in jobs] == [opp.id, opp.id]
    self_edit_job = jobs[1]
    assert "Accept or suggest a correction?" in self_edit_job.body
    assert "Accept or counter?" not in self_edit_job.body


async def test_solo_result_enqueues_no_confirmation(
    api_client: AsyncClient,
    db_session: AsyncSession,
    fake_notifications_queue: Queue,
):
    """A solo (opponent-less) match finalizes on post with nobody to confirm —
    so no confirmation delivery is enqueued."""
    await start_session(api_client, db_session)

    created = await api_client.post("/v1/matches", json={"best_of": 1, "rated": False})
    assert created.status_code == 201
    match = created.json()

    response = await api_client.post(
        f"/v1/matches/{match['id']}/results",
        json={"games": [{"game_number": 1, "side_1_points": 11, "side_2_points": 5}]},
    )
    assert response.status_code == 201
    assert enqueued_notification_jobs(fake_notifications_queue) == []


async def test_unrated_result_enqueues_no_confirmation(
    api_client: AsyncClient,
    db_session: AsyncSession,
    fake_notifications_queue: Queue,
):
    """An unrated match finalizes on post with nothing for the opponent to
    confirm — so no confirmation delivery is enqueued."""
    await start_session(api_client, db_session)

    async with opponent_session(db_session, "rival") as (_opp_client, opp):
        created = await api_client.post(
            "/v1/matches",
            json={"opponent_user_id": str(opp.id), "best_of": 1, "rated": False},
        )
        assert created.status_code == 201
        match = created.json()

        response = await api_client.post(
            f"/v1/matches/{match['id']}/results",
            json={
                "games": [{"game_number": 1, "side_1_points": 11, "side_2_points": 5}]
            },
        )
        assert response.status_code == 201

    assert enqueued_notification_jobs(fake_notifications_queue) == []


# ----- voiding a match (#750, ADR 0013) -----------------------------------


async def _completed_rated_match(
    db: AsyncSession,
    league: League,
    winner: User,
    loser: User,
) -> Match:
    """Persist a completed, rated singles match: two sides, one player each, a
    single decided game."""
    settings = MatchSettings(team_size=1, best_of=1, affects_rating=True)
    match = Match(
        match_settings=settings,
        league=league,
        created_by_user_id=winner.id,
        status=MatchStatus.completed,
        completed_at=datetime(2026, 5, 1, tzinfo=UTC),
    )
    side1 = MatchSide(match=match, side_number=1, won=True, score=1)
    side1.players.append(MatchSidePlayer(match=match, user=winner))
    side2 = MatchSide(match=match, side_number=2, won=False, score=0)
    side2.players.append(MatchSidePlayer(match=match, user=loser))
    game = MatchGame(match=match, game_number=1)
    game.score = MatchGameScore(side_1_points=11, side_2_points=4)
    db.add(match)
    await db.commit()
    await db.refresh(match)
    return match


def _match_history_row(
    league: League,
    user: User,
    match: Match | None,
    strategy: RatingStrategy,
    source: RatingHistorySource,
) -> RatingHistory:
    return RatingHistory(
        league_id=league.id,
        user_id=user.id,
        match_id=match.id if match is not None else None,
        rating_strategy_id=strategy.id,
        rating_value=1500.0,
        rating_state={"rating": 1500.0, "rd": 350.0, "volatility": 0.06},
        source=source,
    )


async def test_void_sets_status_and_deletes_all_rating_history(
    db_session: AsyncSession,
    default_league: League,
    rating_strategies: dict[str, RatingStrategy],
):
    """Voiding a completed rated match flips it to ``voided`` and drops the
    ``rating_history`` rows for *both* participants — but only for this match.
    A participant's ``initial`` seed row (and any other match's row) survives:
    the delete is scoped by ``match_id``, never by ``user_id``."""
    strategy = rating_strategies["glicko2"]
    winner = await make_user(db_session, "voidwinner")
    loser = await make_user(db_session, "voidloser")
    match = await _completed_rated_match(db_session, default_league, winner, loser)

    # Both participants have a rating-history row for this match...
    db_session.add(
        _match_history_row(
            default_league, winner, match, strategy, RatingHistorySource.match
        )
    )
    db_session.add(
        _match_history_row(
            default_league, loser, match, strategy, RatingHistorySource.match
        )
    )
    # ...and the winner also carries an ``initial`` seed row (match_id NULL)
    # that a by-user delete would wrongly wipe.
    db_session.add(
        _match_history_row(
            default_league, winner, None, strategy, RatingHistorySource.initial
        )
    )
    await db_session.commit()

    await void_match(db_session, match)
    await db_session.commit()
    await db_session.refresh(match)

    assert match.status == MatchStatus.voided

    remaining = (await db_session.execute(select(RatingHistory))).scalars().all()
    # Only the winner's initial seed row is left; both match rows are gone.
    assert [(r.user_id, r.match_id, r.source) for r in remaining] == [
        (winner.id, None, RatingHistorySource.initial)
    ]


async def test_void_leaves_sides_and_players_intact(
    db_session: AsyncSession,
    default_league: League,
    rating_strategies: dict[str, RatingStrategy],
):
    """Voiding is deliberately narrow: it does not prune sides or players.
    Both sides and both side-players survive the void unchanged."""
    winner = await make_user(db_session, "voidkeepwinner")
    loser = await make_user(db_session, "voidkeeploser")
    match = await _completed_rated_match(db_session, default_league, winner, loser)

    await void_match(db_session, match)
    await db_session.commit()

    sides = (
        (
            await db_session.execute(
                select(MatchSide).where(MatchSide.match_id == match.id)
            )
        )
        .scalars()
        .all()
    )
    assert {s.side_number for s in sides} == {1, 2}

    players = (
        (
            await db_session.execute(
                select(MatchSidePlayer).where(MatchSidePlayer.match_id == match.id)
            )
        )
        .scalars()
        .all()
    )
    assert {p.user_id for p in players} == {winner.id, loser.id}

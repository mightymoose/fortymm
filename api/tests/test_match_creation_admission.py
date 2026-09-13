"""Standalone sporting admission bounds retained history across transports."""

import asyncio

import pytest
from sqlalchemy import func, select

from app import match_creation
from app.config import get_settings
from app.models import Match
from tests._helpers import make_user, start_session
from tests.test_mcp_server import _mcp_auth0_verifier as _mcp_auth0_verifier


async def test_standalone_match_budget_refuses_before_database_growth(
    api_client, db_session, monkeypatch
):
    settings = get_settings().model_copy(
        update={"match_creation_account_limit_per_hour": 1}
    )
    monkeypatch.setattr(match_creation, "get_settings", lambda: settings)
    assert (await api_client.get("/v1/session")).status_code == 200
    first = await api_client.post("/v1/matches", json={"best_of": 3, "rated": False})
    assert first.status_code == 201
    before = await db_session.scalar(select(func.count()).select_from(Match))
    refused = await api_client.post("/v1/matches", json={"best_of": 3, "rated": False})
    assert refused.status_code == 429
    assert refused.headers["Retry-After"] == "3600"
    assert await db_session.scalar(select(func.count()).select_from(Match)) == before


@pytest.mark.parametrize("window,seconds", [("hour", 3600), ("day", 86400)])
async def test_match_budgets_expire_and_existing_scoring_remains_available(
    api_client, db_session, monkeypatch, rate_limiter_fakeredis, window, seconds
):
    settings = get_settings().model_copy(
        update={
            f"match_creation_account_limit_per_{window}": 1,
        }
    )
    monkeypatch.setattr(match_creation, "get_settings", lambda: settings)
    user = await start_session(api_client, db_session)
    first = await api_client.post("/v1/matches", json={"best_of": 3, "rated": False})
    assert first.status_code == 201
    refused = await api_client.post("/v1/matches", json={"best_of": 3, "rated": False})
    assert refused.status_code == 429
    assert refused.headers["Retry-After"] == str(seconds)
    match_id = first.json()["id"]
    scored = await api_client.post(
        f"/v1/matches/{match_id}/games/1/scores/new",
        json={"side_1_points": 11, "side_2_points": 4},
    )
    assert scored.status_code == 201, scored.text
    for key in await rate_limiter_fakeredis.keys("match-create:*"):
        assert 0 < await rate_limiter_fakeredis.ttl(key) <= 86400
    await rate_limiter_fakeredis.pexpire(f"match-create:{window}:{user.id}", 1)
    await asyncio.sleep(0.01)
    assert (
        await api_client.post("/v1/matches", json={"best_of": 3, "rated": False})
    ).status_code == 201


@pytest.mark.parametrize("failure", ["unpublished", "connection_error"])
async def test_match_creation_fails_closed_without_allocating_rows(
    api_client, db_session, monkeypatch, rate_limiter_fakeredis, failure
):
    from redis.exceptions import ConnectionError

    from app import rate_limiting

    await start_session(api_client, db_session)
    if failure == "unpublished":
        monkeypatch.setattr(rate_limiting, "_redis", None)
    else:

        async def unavailable(*args, **kwargs):
            raise ConnectionError("offline")

        monkeypatch.setattr(rate_limiter_fakeredis, "eval", unavailable)
    before = await db_session.scalar(select(func.count()).select_from(Match))
    result = await api_client.post("/v1/matches", json={"best_of": 3, "rated": False})
    assert result.status_code == 503
    assert result.headers["Retry-After"] == "5"
    assert await db_session.scalar(select(func.count()).select_from(Match)) == before


async def test_account_budget_shared_across_http_and_mcp_but_not_other_accounts(
    api_client, db_session, monkeypatch
):
    from tests.test_mcp_server import _mcp_client, _mint

    settings = get_settings().model_copy(
        update={"match_creation_account_limit_per_hour": 1}
    )
    monkeypatch.setattr(match_creation, "get_settings", lambda: settings)
    actor = await start_session(api_client, db_session)
    raw = await _mint(db_session, actor)
    assert (
        await api_client.post("/v1/matches", json={"best_of": 3, "rated": False})
    ).status_code == 201
    async with _mcp_client(raw) as client, client:
        refused = await client.call_tool_mcp(
            "create_match", {"best_of": 3, "rated": False}
        )
        assert refused.isError
        assert "Too many new matches" in str(refused.content)
    other = await make_user(db_session, "independent-match-creator")
    created = await match_creation.create_match(
        db_session,
        creator=other,
        opponent_user_id=None,
        league_id=None,
        best_of=3,
        rated=False,
    )
    assert created.created_by_user_id == other.id


async def test_concurrent_match_admission_cannot_exceed_account_limit(
    db_session, engine, monkeypatch
):
    from sqlalchemy.ext.asyncio import async_sessionmaker

    from app.match_errors import MatchCreationRateLimitedError

    settings = get_settings().model_copy(
        update={"match_creation_account_limit_per_hour": 1}
    )
    monkeypatch.setattr(match_creation, "get_settings", lambda: settings)
    actor = await make_user(db_session, "racing-match-creator")
    await db_session.commit()
    sessions = async_sessionmaker(engine, expire_on_commit=False)

    async def create():
        async with sessions() as session:
            try:
                await match_creation.create_match(
                    session,
                    creator=actor,
                    opponent_user_id=None,
                    league_id=None,
                    best_of=3,
                    rated=False,
                )
                return True
            except MatchCreationRateLimitedError:
                return False

    results = await asyncio.gather(*(create() for _ in range(8)))
    assert results.count(True) == 1
    assert await db_session.scalar(select(func.count()).select_from(Match)) == 1


async def test_tournament_materialization_does_not_require_standalone_admission(
    db_session, monkeypatch
):
    from app import rate_limiting
    from app.models import Tournament
    from app.tournament_materialization import materialize_live_draw
    from tests.test_match_calls import _make_tournament, _the_fixture

    tournament_id, event_id = await _make_tournament(db_session)
    tournament = await db_session.get(Tournament, tournament_id)
    monkeypatch.setattr(rate_limiting, "_redis", None)
    await materialize_live_draw(db_session, tournament)
    fixture = await _the_fixture(db_session, event_id)
    assert fixture.match_id is not None


async def test_mcp_creation_reports_unavailable_budget_without_creating_match(
    db_session, monkeypatch
):
    from app import rate_limiting
    from tests.test_mcp_server import _mcp_client, _mint

    actor = await make_user(db_session, "offline-mcp-creator")
    raw = await _mint(db_session, actor)
    monkeypatch.setattr(rate_limiting, "_redis", None)
    async with _mcp_client(raw) as client, client:
        refused = await client.call_tool_mcp(
            "create_match", {"best_of": 3, "rated": False}
        )
        assert refused.isError
        assert "temporarily unavailable" in str(refused.content)
    assert await db_session.scalar(select(func.count()).select_from(Match)) == 0


@pytest.mark.parametrize("window", ["hour", "day"])
@pytest.mark.parametrize("value", ["0", "-1", "1.5", "unlimited"])
def test_match_creation_budget_configuration_requires_positive_integer(
    monkeypatch, window, value
):
    from pydantic import ValidationError

    monkeypatch.setenv(f"MATCH_CREATION_ACCOUNT_LIMIT_PER_{window.upper()}", value)
    with pytest.raises(ValidationError):
        get_settings()

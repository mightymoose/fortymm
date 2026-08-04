"""The HTTP adapters for the ephemeral **schedule preview** verb — enqueue, poll
and cancel (chore 1c of ADR "a schedule preview is a non-persistent solve over a
synthetic field").

These exercise the three thin routes over real HTTP (sessions via
``GET /v1/session``, CSRF baked into the clients — the ``tests/test_tournaments.py``
conventions), proving they adapt the transport-neutral 1b verb to the exact
status codes:

* ``POST …/schedule/preview`` returns a ``202`` with the token + immediate
  structure (field sizes + drawn fixtures), placing a job on the **preview**
  queue;
* ``GET …/schedule/preview/{token}`` polls that job — ``queued`` before a worker
  runs it, ``done`` with the ``PreviewResult`` once it has;
* ``DELETE …/schedule/preview/{token}`` best-effort cancels — ``204`` for a real
  token (dropping the job so it can no longer be polled) and ``204`` for a token
  Redis never knew (a no-op success, never a ``500``);
* a non-owner is ``403``, a ``live``/``archived`` tournament ``409``, an event
  whose draw type the scheduler cannot place (single-elim) ``422`` — in a
  sentence that names the draw type — and exceeding the per-session rate limit
  ``429``.

Under the async (record-only) ``preview_queue`` fixture the enqueued job is
inspected and then run through a real in-process worker (the DB-blind preview job
needs no test database), so its result lands in Redis exactly as a deployed
worker would leave it and the poll reads it back.
"""

import uuid
from collections.abc import AsyncIterator
from decimal import Decimal

import fakeredis
import pytest
import pytest_asyncio
from httpx import AsyncClient
from rq import Queue, SimpleWorker
from sqlalchemy.ext.asyncio import AsyncSession

from app import queue as queue_module
from app.leagues import get_default_league
from app.models import (
    DrawType,
    EventFormat,
    Tournament,
    TournamentEvent,
    TournamentEventDrawSettings,
    TournamentStatus,
    User,
)
from app.schedule_preview_solve import RUN_SCHEDULE_PREVIEW_JOB
from tests._helpers import (
    make_client,
    start_session,
    venue_tables,
    with_table_aliases,
)

# Built per tournament, never as a module constant: a catalogue is
# ``tournament_tables`` rows now (ADR 20260801). The pool below names them by the
# positional ``t1``/``t2`` aliases ``with_table_aliases`` resolves.
TABLE_CATALOGUE = (("Table 1", "A"), ("Table 2", "A"))


@pytest.fixture
def preview_queue(monkeypatch: pytest.MonkeyPatch) -> Queue:
    """An async (record-only) RQ queue on fakeredis standing in for the real
    ``preview`` queue, so a test can inspect the enqueued job and then run it
    through a real worker. Its connection is what ``preview_job_state`` /
    ``cancel_preview`` read, since both go through the same monkeypatched
    ``get_preview_queue``."""
    connection = fakeredis.FakeStrictRedis()
    q = Queue(queue_module.PREVIEW_QUEUE, connection=connection, is_async=True)
    monkeypatch.setattr(queue_module, "get_preview_queue", lambda: q)
    return q


@pytest_asyncio.fixture
async def authed_client(
    api_client: AsyncClient, db_session: AsyncSession
) -> AsyncIterator[tuple[AsyncClient, User]]:
    """The primary ``api_client`` with a real session whose user owns the
    tournament under test. A preview is owner-gated, not permission-gated, so no
    grants are needed."""
    user = await start_session(api_client, db_session)
    yield api_client, user


def _preview_url(tournament_id: uuid.UUID | str) -> str:
    return f"/v1/tournaments/{tournament_id}/schedule/preview"


def _token_url(tournament_id: uuid.UUID | str, token: str) -> str:
    return f"/v1/tournaments/{tournament_id}/schedule/preview/{token}"


async def _make_tournament(
    db: AsyncSession,
    owner: User,
    *,
    status: TournamentStatus = TournamentStatus.draft,
    with_event: bool = True,
    draw_type: DrawType = DrawType.round_robin,
) -> uuid.UUID:
    """A tournament owned by ``owner`` (a two-table catalogue and, unless
    ``with_event=False``, one pooled event of ``draw_type`` capped at four players
    over both tables). Written straight to the database — creation routes are not
    under test here. No ``TournamentEntry`` rows: a preview draws a synthetic
    field."""
    league = await get_default_league(db)
    assert league is not None, "the autouse default_league fixture seeds this"

    tournament = Tournament(
        name="Preview Open 2030",
        status=status,
        address={
            "venue": "Berkeley TT Club",
            "street": "1 Shattuck Ave",
            "city": "Berkeley",
            "region": "CA",
            "postal": "94704",
            "country": "USA",
            "latitude": 37.8703,
            "longitude": -122.2731,
        },
        tables=venue_tables(*TABLE_CATALOGUE),
        league_id=league.id,
        created_by_user_id=owner.id,
    )
    db.add(tournament)
    await db.flush()

    if with_event:
        event = TournamentEvent(
            tournament_id=tournament.id,
            name="Open Singles",
            format=EventFormat.singles,
            draw_settings=TournamentEventDrawSettings.for_draw_type(draw_type),
            max_players=4,
            entry_fee=Decimal("0.00"),
            slot={"date": "2030-01-01", "start": "09:00", "end": "17:00"},
            match_settings={"rated": False, "length_games": 3},
            timezone="America/Los_Angeles",
            pools=with_table_aliases(
                tournament,
                [
                    {
                        "name": "Pool A",
                        "slot": {
                            "date": "2030-01-01",
                            "start": "09:00",
                            "end": "17:00",
                        },
                        "table_ids": ["t1", "t2"],
                    }
                ],
            ),
        )
        db.add(event)
        await db.flush()

    await db.commit()
    return tournament.id


def _drain_preview_job(queue: Queue) -> None:
    """Run the single recorded preview job through a real in-process worker so its
    return value is pickled into the job's Redis result, exactly as a deployed
    worker would leave it. Asserts the job's identity + routing first."""
    (job,) = queue.jobs
    assert job.func_name == RUN_SCHEDULE_PREVIEW_JOB
    assert job.origin == queue_module.PREVIEW_QUEUE
    worker = SimpleWorker([queue], connection=queue.connection)
    worker.work(burst=True)


# ----- the enqueue (202) + its immediate structure ---------------------------


async def test_owner_enqueues_a_preview_and_gets_a_token_and_structure(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    preview_queue: Queue,
) -> None:
    """202: a token plus the immediately-known structure — the per-event field
    size (capped at four) and the six drawn round-robin fixtures — so a caller
    renders a skeleton before the solve returns. The job lands on the preview
    queue."""
    client, owner = authed_client
    tournament_id = await _make_tournament(db_session, owner)

    response = await client.post(_preview_url(tournament_id))

    assert response.status_code == 202, response.text
    body = response.json()
    assert body["token"]
    assert [s["field_size"] for s in body["field_summaries"]] == [4]
    assert len(body["fixtures"]) == 6
    # Each drawn fixture carries the human pool label (not just the namespaced
    # composite) so the grid can head its column "Pool A".
    assert {f["pool_name"] for f in body["fixtures"]} == {"Pool A"}

    (job,) = preview_queue.jobs
    assert job.func_name == RUN_SCHEDULE_PREVIEW_JOB


async def test_overrides_in_the_body_change_the_drawn_field(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    preview_queue: Queue,
) -> None:
    """The optional per-event override sizes the synthetic field: six entrants
    draws fifteen round-robin fixtures, not the capped four's six."""
    client, owner = authed_client
    tournament_id = await _make_tournament(db_session, owner)

    # Grab the single event id off the immediate structure of an unsized preview.
    seed = (await client.post(_preview_url(tournament_id))).json()
    event_id = seed["field_summaries"][0]["event_id"]

    response = await client.post(
        _preview_url(tournament_id), json={"overrides": {event_id: 6}}
    )

    assert response.status_code == 202, response.text
    body = response.json()
    assert [s["field_size"] for s in body["field_summaries"]] == [6]
    assert len(body["fixtures"]) == 15


async def test_an_unknown_body_key_is_rejected(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    preview_queue: Queue,
) -> None:
    """The request model forbids extras — a typo'd key is a 422 client bug, not a
    silently dropped field."""
    client, owner = authed_client
    tournament_id = await _make_tournament(db_session, owner)

    response = await client.post(_preview_url(tournament_id), json={"overides": {}})

    assert response.status_code == 422, response.text


# ----- the poll (GET) --------------------------------------------------------


async def test_polling_before_the_worker_runs_reports_queued(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    preview_queue: Queue,
) -> None:
    """A token polled before any worker has picked the job up is ``queued`` —
    waiting for a slot, no result yet."""
    client, owner = authed_client
    tournament_id = await _make_tournament(db_session, owner)
    token = (await client.post(_preview_url(tournament_id))).json()["token"]

    state = (await client.get(_token_url(tournament_id, token))).json()

    assert state["status"] == "queued"
    assert state["result"] is None


async def test_polling_after_the_worker_runs_returns_the_result(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    preview_queue: Queue,
) -> None:
    """Once the worker has drained the job, the poll returns ``done`` carrying the
    whole ``PreviewResult`` — a verdict that fits, the counts (six matches over
    four synthetic entrants), and the always-present honest-notes strip."""
    client, owner = authed_client
    tournament_id = await _make_tournament(db_session, owner)
    token = (await client.post(_preview_url(tournament_id))).json()["token"]

    _drain_preview_job(preview_queue)

    state = (await client.get(_token_url(tournament_id, token))).json()

    assert state["status"] == "done"
    result = state["result"]
    assert result is not None
    assert result["verdict"] in ("optimal", "feasible")
    assert result["fits"] is True
    assert result["total_matches"] == 6
    assert result["notes"]


async def test_polling_is_owner_only(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    preview_queue: Queue,
) -> None:
    """A token is the owner's — a stranger polling it is a 403, before the
    tournament-blind Redis job is even read."""
    client, owner = authed_client
    tournament_id = await _make_tournament(db_session, owner)
    token = (await client.post(_preview_url(tournament_id))).json()["token"]

    async with make_client() as stranger:
        await start_session(stranger, db_session)
        response = await stranger.get(_token_url(tournament_id, token))

    assert response.status_code == 403


# ----- the cancel (DELETE) ---------------------------------------------------


async def test_cancelling_a_live_token_is_204_and_drops_the_job(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    preview_queue: Queue,
) -> None:
    """A real queued token cancels to 204, and the dropped job can no longer be
    polled back as a success — it reads as ``failed`` (no longer available)."""
    client, owner = authed_client
    tournament_id = await _make_tournament(db_session, owner)
    token = (await client.post(_preview_url(tournament_id))).json()["token"]

    response = await client.delete(_token_url(tournament_id, token))

    assert response.status_code == 204, response.text
    polled = (await client.get(_token_url(tournament_id, token))).json()
    assert polled["status"] == "failed"


async def test_cancelling_a_missing_token_is_a_noop_success(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    preview_queue: Queue,
) -> None:
    """A cancel is best-effort: a token Redis never knew is a 204 no-op, never a
    500 — the only invariant a cancel protects ("this job is not consuming a
    worker") is already satisfied."""
    client, owner = authed_client
    tournament_id = await _make_tournament(db_session, owner)

    response = await client.delete(_token_url(tournament_id, uuid.uuid4().hex))

    assert response.status_code == 204, response.text


async def test_cancelling_is_owner_only(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    preview_queue: Queue,
) -> None:
    """A stranger cannot cancel the owner's preview — 403, before the Redis job is
    touched."""
    client, owner = authed_client
    tournament_id = await _make_tournament(db_session, owner)
    token = (await client.post(_preview_url(tournament_id))).json()["token"]

    async with make_client() as stranger:
        await start_session(stranger, db_session)
        response = await stranger.delete(_token_url(tournament_id, token))

    assert response.status_code == 403
    # The job survives a refused cancel — the owner can still poll it.
    assert (await client.get(_token_url(tournament_id, token))).json()[
        "status"
    ] == "queued"


async def test_a_token_is_bound_to_its_tournament_against_a_cross_tournament_idor(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    preview_queue: Queue,
) -> None:
    """The cross-tournament IDOR guard: an owner who pairs their OWN valid pre-live
    tournament id with another director's preview token gets a 404 on both poll and
    cancel — not a leak of the victim's preview state, and not a cancel of it. Owning
    *a* pre-live tournament is not enough; the token is bound to the tournament it was
    enqueued FOR."""
    attacker_client, attacker = authed_client
    attacker_tournament = await _make_tournament(db_session, attacker)

    async with make_client() as victim_client:
        victim = await start_session(victim_client, db_session)
        victim_tournament = await _make_tournament(db_session, victim)
        victim_token = (
            await victim_client.post(_preview_url(victim_tournament))
        ).json()["token"]

        # The attacker owns a valid pre-live tournament and supplies its id + the
        # victim's token: the ownership + pre-live gate on the attacker's tournament
        # passes, but the token was enqueued for the victim's → 404, not a leak.
        poll = await attacker_client.get(_token_url(attacker_tournament, victim_token))
        assert poll.status_code == 404, poll.text
        cancel = await attacker_client.delete(
            _token_url(attacker_tournament, victim_token)
        )
        assert cancel.status_code == 404, cancel.text

        # The victim's preview survived the attack — still pollable by its own owner.
        survived = (
            await victim_client.get(_token_url(victim_tournament, victim_token))
        ).json()
        assert survived["status"] == "queued"


# ----- the gates: 404 / 403 / 409 / 429 --------------------------------------


async def test_preview_for_an_absent_tournament_is_404(
    authed_client: tuple[AsyncClient, User],
    preview_queue: Queue,
) -> None:
    client, _ = authed_client
    response = await client.post(_preview_url(uuid.uuid4()))
    assert response.status_code == 404


async def test_preview_is_owner_only(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    preview_queue: Queue,
) -> None:
    """A preview is a property of owning the tournament — a stranger with a valid
    session is a 403, and nothing is enqueued."""
    _, owner = authed_client
    tournament_id = await _make_tournament(db_session, owner)

    async with make_client() as stranger:
        await start_session(stranger, db_session)
        response = await stranger.post(_preview_url(tournament_id))

    assert response.status_code == 403
    assert preview_queue.jobs == []


@pytest.mark.parametrize("status", [TournamentStatus.live, TournamentStatus.archived])
async def test_preview_on_a_post_live_tournament_is_409(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    preview_queue: Queue,
    status: TournamentStatus,
) -> None:
    """A preview answers a pre-registration question, so a ``live`` or
    ``archived`` tournament is a 409 — there is a real field and a real solve to
    look at, or it is over. Nothing is enqueued."""
    client, owner = authed_client
    tournament_id = await _make_tournament(db_session, owner, status=status)

    response = await client.post(_preview_url(tournament_id))

    assert response.status_code == 409, response.text
    assert preview_queue.jobs == []


async def test_preview_of_a_single_elim_event_is_a_422_that_names_the_draw_type(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    preview_queue: Queue,
) -> None:
    """A single-elim event is a 422 whose sentence names the **draw type** — the one
    thing the director has to change — not the generic "as the event stands".

    ``app.schedule_preview`` is the last live raiser of ``UnsupportedDrawType``: the
    CP-SAT scheduler places pooled draws over their pools' windows and a bracket has
    none, so the preview refuses rather than invent a grid. That refusal reaches this
    route through ``_draw_refusal`` — the mapper the **cut** route shares, where the
    error is now unreachable because ``strategy_for`` is total. That asymmetry is
    exactly the trap: the arm looks dead from the cut route's side, and deleting it
    still leaves this route answering 422 — just with the generic fallback, which
    blames the event's own pools and field and sends the director hunting through two
    things that are perfectly fine.

    So the assertion is on the **sentence**, not the status. ``status_code == 422``
    passes with the arm deleted; naming ``single-elim`` does not.
    """
    client, owner = authed_client
    tournament_id = await _make_tournament(
        db_session, owner, draw_type=DrawType.single_elim
    )

    response = await client.post(_preview_url(tournament_id))

    assert response.status_code == 422, response.text
    detail = response.json()["detail"]
    # The load-bearing assertion: the draw type is named, off the error's structural
    # ``draw_type`` rather than parsed out of a developer's message.
    assert DrawType.single_elim.value in detail, detail
    # And it is not the generic fallback, which is about the event's state (and, in
    # the cut route's voice, about cutting — a verb this route never performs).
    assert detail != "This event's draw cannot be cut as the event stands."
    assert "cannot be cut" not in detail
    # Nothing is queued: an un-schedulable event refuses the whole preview up front,
    # never a partial solve over the events that would have worked.
    assert preview_queue.jobs == []


async def test_exceeding_the_rate_limit_is_429(
    authed_client: tuple[AsyncClient, User],
    db_session: AsyncSession,
    preview_queue: Queue,
) -> None:
    """The expensive enqueue is rate limited per owner (six a minute): a burst of
    seven from one director sees the seventh refused with a 429."""
    client, owner = authed_client
    tournament_id = await _make_tournament(db_session, owner)

    statuses = [
        (await client.post(_preview_url(tournament_id))).status_code for _ in range(7)
    ]

    assert statuses[:6] == [202] * 6
    assert statuses[6] == 429

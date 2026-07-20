"""The transport-neutral edit-tournament write verb.

The orchestration behind ``PATCH /v1/tournaments/{id}`` — the ``FOR UPDATE``
load-lock, the owner gate, the league-editable-only-while-draft state rule
(ADR-0783), the STRICT league resolution, the partial apply, and the
table-catalogue-change → re-solve trigger — extracted out of the router so it can
run without FastAPI: from the HTTP adapter (``app.tournaments.update_tournament``)
and from the MCP ``edit_tournament`` tool alike, and be constructed in a plain
REPL with a raw session.

Per the tournament-verbs ADR (mirroring the match-flow ADR), it signals every
refusal with a **domain exception** from ``app.tournament_errors`` — never an
``HTTPException`` — and each adapter maps it back to the exact response it
produced before. In particular the league lookup does NOT reuse ``resolve_league``
(``app.leagues``), which raises an ``HTTPException`` a FastAPI-free verb must not
let escape: it resolves through the FastAPI-free ``_load_league`` and raises
:class:`LeagueNotFoundError` on a miss, the transport-neutral equivalent of that
resolver's strict 404.
"""

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.leagues import _load_league
from app.models import ScheduleSolveTrigger, Tournament, TournamentStatus, User
from app.schedule_solves import request_solve, tournament_has_drawn_event
from app.schemas.tournament import TournamentTable, TournamentUpdate
from app.tournament_errors import (
    LeagueNotEditableError,
    LeagueNotFoundError,
    NotTournamentOwnerError,
    TournamentNotFoundError,
)


async def _load_tournament_for_update(
    db: AsyncSession, tournament_id: uuid.UUID
) -> Tournament:
    """Load the tournament row with ``FOR UPDATE`` held for the rest of the
    transaction, or raise :class:`TournamentNotFoundError`.

    The FastAPI-free twin of the router's ``_get_tournament_for_update_or_404``:
    the edit path *judges the status and then writes* (the league guard reads
    ``status``, ADR-0783), so it takes the tournament row lock — on the same row,
    in the same order the transition and entry routes take it — before any read
    the write depends on. Postgres runs READ COMMITTED, so without the lock a
    league change could pass the ``draft`` check, a concurrent publish could
    commit, and the UPDATE could land behind it, moving the ladder under a
    tournament whose registration is already open. The lock is taken
    unconditionally though the status is only *judged* when the payload carries a
    ``league_id``: one loader is simpler than a branch, and a name-only edit that
    queues behind a publish is harmless.
    """
    tournament = (
        await db.execute(
            select(Tournament).where(Tournament.id == tournament_id).with_for_update()
        )
    ).scalar_one_or_none()
    if tournament is None:
        raise TournamentNotFoundError()
    return tournament


async def _load_owned_tournament_for_update(
    db: AsyncSession, tournament_id: uuid.UUID, actor: User
) -> Tournament:
    """Load the tournament ``actor`` owns under ``FOR UPDATE``, or raise — the
    lock-then-owner-gate pair every owner-only tournament write shares.

    Composes :func:`_load_tournament_for_update` (the row lock, raising
    :class:`TournamentNotFoundError`) with the owner gate (raising
    :class:`NotTournamentOwnerError`), in that order: the 404 is judged before the
    403, so a caller who is not the owner never learns whether an absent id existed.
    The single home for the two lines the edit, solve and draw write cores each ran
    inline — same exceptions, same order — so a fourth write core cannot grow a
    fifth opinion about what "the owner's locked tournament" means.
    """
    tournament = await _load_tournament_for_update(db, tournament_id)
    if tournament.created_by_user_id != actor.id:
        raise NotTournamentOwnerError()
    return tournament


def _catalogue_ids(tournament: Tournament) -> list[str]:
    """The table catalogue reduced to its ``id`` list — the only slice of it the
    solver reads (``_load_solver_inputs`` reduces the catalogue to ``TableId``s;
    labels and courts are display). Parsed with the same model the write boundary
    validated it with, so the before/after comparison is over what actually feeds
    a solve: a rename/address/date edit and a label-only re-word trigger nothing,
    adding/removing/re-identifying a table triggers a re-solve."""
    return [
        TournamentTable.model_validate(table).id for table in tournament.table_catalogue
    ]


async def edit_tournament(
    db: AsyncSession,
    *,
    tournament_id: uuid.UUID,
    actor: User,
    updates: TournamentUpdate,
) -> Tournament:
    """Apply the partial ``updates`` to the tournament ``actor`` owns, and return
    the refreshed :class:`Tournament`.

    Loads under the tournament row lock (:func:`_load_tournament_for_update`) and
    runs the same orchestration the HTTP handler used to run inline:

    * **404** — an absent tournament id raises :class:`TournamentNotFoundError`.
      Loaded first, so ownership is judged only once the row exists.
    * **403** — a caller who is not the tournament's creator raises
      :class:`NotTournamentOwnerError`. Tournament mutations are owner-gated
      (``created_by_user_id == actor.id``), not RBAC-gated.
    * **409** — a ``league_id`` in the payload on a tournament that has left
      ``draft`` raises :class:`LeagueNotEditableError` (carrying the current
      status): once published, registration is open and eligibility is live, so
      the ladder is settled (ADR-0783). Judged *before* the league is looked up,
      so a caller who cannot change it learns nothing about which leagues exist.
    * **404** — a ``league_id`` that names no league raises
      :class:`LeagueNotFoundError` (the STRICT resolution, via the FastAPI-free
      ``_load_league``): a director's typo must not silently swap to the default.

    Then it applies the remaining fields (``model_dump(exclude_unset=True)``
    already serialized the nested value-objects to plain dicts/lists, so one
    ``setattr`` loop covers the JSONB and scalar columns alike) and, when the
    table-catalogue ids changed AND at least one event is drawn, requests a
    ``settings_changed`` solve inside this transaction under the row lock (the
    lock order ``request_solve`` requires). A ``None`` return from
    ``request_solve`` (Redis down) is deliberately ignored: the edit is what the
    owner asked for, and the missing solve is recovered by the pin tick or the
    Run-scheduler button.

    Commits and refreshes before returning. Never raises ``HTTPException`` — the
    caller adapts each domain exception to its transport.
    """
    tournament = await _load_owned_tournament_for_update(db, tournament_id, actor)

    fields = updates.model_dump(exclude_unset=True)

    # The league is the one field with a *state* rule (ADR-0783), so it comes out
    # of the generic loop and is judged before anything is written — and the
    # refusal is raised before the league is looked up, so a caller who cannot
    # change it learns nothing about whether the league they named exists.
    if "league_id" in fields:
        if tournament.status is not TournamentStatus.draft:
            raise LeagueNotEditableError(tournament.status.value)
        # STRICT resolution, exactly as on create — but via the FastAPI-free
        # ``_load_league`` rather than ``resolve_league`` (which raises an
        # ``HTTPException`` this verb must not let escape). The schema rejects an
        # explicit ``null`` for ``league_id``, so it is always a real id here.
        league = await _load_league(db, fields.pop("league_id"))
        if league is None:
            raise LeagueNotFoundError()
        tournament.league_id = league.id

    catalogue_ids_before = _catalogue_ids(tournament)
    for key, value in fields.items():
        setattr(tournament, key, value)
    catalogue_ids_after = _catalogue_ids(tournament)

    if catalogue_ids_after != catalogue_ids_before and await tournament_has_drawn_event(
        db, tournament_id
    ):
        await request_solve(db, tournament_id, ScheduleSolveTrigger.settings_changed)

    await db.commit()
    await db.refresh(tournament)
    return tournament

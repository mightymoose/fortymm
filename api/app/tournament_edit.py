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
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.geocoding import Geocoder
from app.leagues import _load_league
from app.models import ScheduleSolveTrigger, Tournament, TournamentStatus, User
from app.schedule_solves import request_solve, tournament_has_drawn_event
from app.schemas.tournament import (
    Address,
    AddressInput,
    TournamentUpdate,
)
from app.tournament_errors import (
    LeagueNotEditableError,
    LeagueNotFoundError,
    NotTournamentOwnerError,
    TournamentNotFoundError,
)
from app.tournament_geocoding import geocode_address
from app.tournament_realtime import stage_event_entrant_hints
from app.tournament_tables import apply_table_catalogue


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


#: The six free-text components of a venue address — the fields a client sends
#: (:class:`~app.schemas.tournament.AddressInput`) and the fields stored alongside the
#: server-geocoded coordinates. The coordinates are deliberately NOT in this tuple: they
#: are the server's to (re)compute, and are exactly what is kept when the text is
#: unchanged.
_ADDRESS_TEXT_FIELDS: tuple[str, ...] = (
    "venue",
    "street",
    "city",
    "region",
    "postal",
    "country",
)


async def _stored_address(
    db: AsyncSession, tournament_id: uuid.UUID
) -> dict[str, Any] | None:
    """The tournament's currently-stored ``address`` JSONB (six text fields plus the
    geocoded coordinates), read **without** the row lock — or ``None`` if the
    tournament has no venue, or no such tournament exists.

    Those two ``None``s are deliberately not told apart. The only question this read
    answers is "is the submitted address the one already stored?", and the answer is
    "no" in both cases: a venue-less tournament has nothing to match, and a tournament
    this unlocked read cannot see is judged by the locked owner-load instead.

    Lock-free on purpose: it exists only to decide whether a submitted address is
    actually changing, and that decision must not hold the ``FOR UPDATE`` lock across
    the (up-to-5s) geocode network call it gates. It is an **optimization only** — the
    authoritative write still happens under the lock in :func:`edit_tournament`, and a
    stale read here can at worst cost one needless geocode or skip one, never a wrong or
    coordinate-less write (see the address branch there for the race reasoning)."""
    return (
        await db.execute(
            select(Tournament.address).where(Tournament.id == tournament_id)
        )
    ).scalar_one_or_none()


def _address_text_unchanged(submitted: AddressInput, stored: dict[str, Any]) -> bool:
    """True when ``submitted``'s six free-text components equal ``stored``'s six.

    Compared field-by-field over :data:`_ADDRESS_TEXT_FIELDS` rather than by dict
    equality, because ``stored`` also carries ``latitude``/``longitude`` that
    ``AddressInput`` does not — and those coordinates are precisely what is preserved
    when the text has not moved."""
    return all(
        getattr(submitted, field) == stored.get(field) for field in _ADDRESS_TEXT_FIELDS
    )


async def edit_tournament(
    db: AsyncSession,
    *,
    tournament_id: uuid.UUID,
    actor: User,
    updates: TournamentUpdate,
    geocoder: Geocoder,
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

    An **address change re-geocodes** (:func:`geocode_address`, via the injected
    ``geocoder``) — but the geocode runs **before the row lock is taken**, never under
    it. The geocode is an external HTTP call (up to ~5s); the tournament ``FOR UPDATE``
    lock serializes every writer of this tournament, so geocoding under it would block
    them all for a network round-trip — the same reason the CP-SAT solve runs outside
    any transaction (``app.schedule_solves``). So a patch that carries a *changed*
    ``address`` (the six free-text components,
    :class:`~app.schemas.tournament.AddressInput`) is resolved to coordinates first, and
    the coordinate-bearing :class:`~app.schemas.tournament.Address` is written under the
    lock, keeping the NOT NULL coordinates invariant (ADR "a venue's coordinates are
    geocoded server-side at write time and are NOT NULL").

    And it geocodes **only when the address text actually changes**. The web client
    sends ``address`` on every edit, so re-geocoding on each PATCH would bill the
    provider for a name-only edit. A **lock-free** read of the stored address
    (:func:`_stored_address`) decides: submitted six text fields identical to the stored
    six ⇒ no geocode, the stored coordinates stand. That read is only an optimization;
    the authoritative write is under the lock (see the address branch in the body for
    why it is correct whatever a concurrent writer does in between). A patch that does
    **not** touch ``address`` geocodes nothing. An unresolvable new address raises
    :class:`~app.geocoding.AddressNotGeocodableError` **before the lock and before any
    field is written or committed**, so the edit is atomic — nothing changes; the caller
    maps it to a coded ``409``
    (:data:`~app.tournament_geocoding.ADDRESS_NOT_GEOCODABLE_CODE`).

    **``address`` has three cases, and the value alone cannot tell them apart** (#1206;
    the 2026-07-26 amendment to that ADR). Omitted ⇒ unchanged. An explicit ``null`` —
    or an all-blank object, which :data:`~app.schemas.tournament.SubmittedAddress`
    normalizes to ``null`` at the boundary — ⇒ **remove the venue**, writing SQL
    ``NULL``, geocoding nothing. A real address ⇒ the change-detection above. Since
    ``TournamentUpdate.address`` defaults to ``None``, "omitted" and "remove" share a
    value, so both branches key on ``"address" in updates.model_fields_set``, never on
    ``updates.address is not None``.

    A submitted ``table_catalogue`` is applied as an **id-keyed diff**
    (:func:`~app.tournament_tables.apply_table_catalogue`) rather than assigned: the
    catalogue is child rows now (ADR 20260801), so an entry citing an ``id`` keeps that
    row (with this payload's words and place), an entry with no ``id`` adds one, and a
    stored table no entry cites is removed. Keying on the id is what keeps the catalogue
    the web client re-sends on every PATCH from re-minting anybody's id — and what makes
    a **reorder move tables** instead of swapping labels between ids, which the
    by-position stopgap it replaces did silently.

    That gives the verb two more refusals, both judged **before anything is written**:

    * **422** — an entry citing an id this tournament's catalogue does not hold raises
      :class:`~app.tournament_errors.TableNotInCatalogueError`, naming the entry.
    * **409** — a removal that a fixture's **placement** stands in the way of raises
      :class:`~app.tournament_errors.TableInUseError`, naming the table by label, unless
      the payload carries ``unplace_fixtures_on_removed_tables``. With the opt-in the
      removal goes through and those fixtures are unplaced (table, start and pin all
      cleared) and their events' entrants are hinted. A table only a **pool** reserves
      needs no opt-in and produces no refusal: the pool quietly reserves one fewer. The
      asymmetry is the ADR's point — clearing a placement destroys information on an
      unrelated write, so the database refuses by default and the director says yes on
      purpose.

    Then it applies the remaining fields (``model_dump(exclude_unset=True)``
    already serialized the nested value-objects to plain dicts/lists, so one
    ``setattr`` loop covers the JSONB and scalar columns alike) and, when the
    table-catalogue gained or lost a table AND at least one event is drawn, requests a
    ``settings_changed`` solve inside this transaction under the row lock (the
    lock order ``request_solve`` requires). Adding or removing a table changes the
    solver's inputs (it reduces the catalogue to its ids); re-wording a label does not.
    A ``None`` return from
    ``request_solve`` (Redis down) is deliberately ignored: the edit is what the
    owner asked for, and the missing solve is recovered by the pin tick or the
    Run-scheduler button.

    Commits and refreshes before returning. Never raises ``HTTPException`` — the
    caller adapts each domain exception to its transport.
    """
    # Whether the payload *carries* an ``address`` at all. This is the field-set, never
    # the value: since #1206 ``updates.address is None`` is ambiguous — it is both "the
    # key was omitted" (leave the venue alone) and "the key was an explicit ``null``, or
    # an all-blank object ``SubmittedAddress`` normalized to one" (remove the venue).
    # Only ``model_fields_set`` tells those apart, so both address branches below are
    # keyed on it.
    address_submitted = "address" in updates.model_fields_set

    # Geocode the changed address BEFORE taking the lock — never under it (see the
    # docstring). There is something to geocode only when the payload carries an address
    # AND that address is a real venue rather than a removal; and even then only when
    # its six text fields differ from what is stored, read lock-free. An unresolvable
    # address raises here, before the lock is taken and before anything is written, so
    # the edit aborts atomically. A removal geocodes nothing: there is no text to
    # resolve, which is why an all-blank address had to be normalized away at the
    # boundary rather than composed into ``""`` and handed to the geocoder (it answers
    # zero candidates, i.e. a coded 409, for the organizer who simply has no venue).
    geocoded_address: Address | None = None
    if address_submitted and updates.address is not None:
        stored = await _stored_address(db, tournament_id)
        if stored is None or not _address_text_unchanged(updates.address, stored):
            # A new venue — or a tournament that currently has none, or one this
            # unlocked read cannot see, in which case the locked owner-load below is the
            # authority and will 404/403 it and this result is simply discarded. Every
            # way round, the geocode is off the lock.
            geocoded_address = await geocode_address(geocoder, updates.address)

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

    # Decide what the ``address`` column gets. ``model_dump`` put the submitted
    # (coordinate-less, or ``None``) value in ``fields``; a submitted address is never
    # written as-is, so this branch replaces it, clears it, or drops it — three cases,
    # exhaustive over a payload that carries the key:
    #
    #   * an explicit removal (``null``, or an all-blank object the boundary normalized
    #     to one) ⇒ write SQL ``NULL``. The organizer un-booked the venue; ``NULL`` is
    #     the single representation of "no venue" (#1206).
    #   * a changed venue (``geocoded_address`` set) ⇒ write it, freshly geocoded.
    #     Correct even if a concurrent edit changed the address between the lock-free
    #     read and this locked write: this is the value the caller asked for, and it
    #     overwrites.
    #   * submitted but unchanged ⇒ do NOT write the column at all, so the stored value
    #     AND its coordinates stand. That is the whole point of the lock-free
    #     comparison (no geocode, coordinates preserved); and if a concurrent edit moved
    #     the venue in between, a caller who submitted the value they had loaded is
    #     expressing no change, so leaving the concurrent value is correct rather than a
    #     lost update.
    #
    # Keyed on ``address_submitted`` (the field-set), NOT on ``updates.address is not
    # None``: that identity meant "an address is on the payload" only because the schema
    # rejected an explicit ``null``, and it stopped being true the moment ``None``
    # became a meaningful value (the ADR amendment names this trap by name). A payload
    # that omits ``address`` skips this whole branch and ``fields`` never held the key.
    if address_submitted:
        if updates.address is None:
            fields["address"] = None
        elif geocoded_address is not None:
            fields["address"] = geocoded_address.model_dump()
        else:
            del fields["address"]

    # Neither of these is a column on ``tournaments``, so both come out of the generic
    # ``setattr`` loop before it runs. The catalogue is child ROWS (ADR 20260801) — a
    # diff, not an assignment — and the opt-in is a *confirmation about this request*,
    # not a value the tournament ends up holding, so there is nothing on the row for
    # either of them to be set on.
    fields.pop("unplace_fixtures_on_removed_tables", None)
    catalogue_changed = False
    unplaced_event_ids: tuple[uuid.UUID, ...] = ()
    submitted_catalogue = updates.table_catalogue
    if submitted_catalogue is not None:
        fields.pop("table_catalogue", None)
        # The id-keyed diff, and its two refusals — an entry citing an id this
        # catalogue does not hold, and a removal a placement stands in the way of. Both
        # raise before a single row is touched, and the commit is at the bottom of this
        # function, so a refused catalogue leaves the tournament exactly as it was —
        # including the ``league_id`` this verb may have set two branches above.
        applied = await apply_table_catalogue(
            db,
            tournament,
            submitted_catalogue,
            # The opt-in's one reading (``true``, and nothing else), so what crosses
            # this seam is a ``bool`` rather than the field's omittable ``bool | None``.
            unplace_fixtures=updates.unplacing_is_confirmed,
        )
        catalogue_changed = applied.changed
        unplaced_event_ids = applied.unplaced_event_ids

    for key, value in fields.items():
        setattr(tournament, key, value)

    if catalogue_changed and await tournament_has_drawn_event(db, tournament_id):
        await request_solve(db, tournament_id, ScheduleSolveTrigger.settings_changed)

    # The opt-in just took a table and a time off somebody's dashboard panel, and — this
    # being a *venue* edit rather than a placement one — nothing else tells them: an
    # unplacing fans out no call and sends no correction, exactly as clearing a
    # placement through ``place_fixture`` does not. Staged on this transaction, so a
    # rollback hints nobody. An ordinary catalogue edit unplaces nothing and this is
    # skipped.
    if unplaced_event_ids:
        await stage_event_entrant_hints(db, list(unplaced_event_ids))

    await db.commit()
    await db.refresh(tournament)
    return tournament

import uuid
from collections import Counter
from datetime import date, datetime
from decimal import ROUND_DOWN, Decimal
from typing import Annotated, Any, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    computed_field,
    field_validator,
    model_validator,
)

from app.models.match import MatchStatus
from app.models.schedule_solve import (
    ScheduleSolveStatus,
    ScheduleSolveTrigger,
    SolverVerdict,
)
from app.models.tournament import DrawType, EventFormat, TournamentStatus
from app.schemas.schedule_solve import (
    ResolvedConflict,
    ResolvedReason,
    parse_infeasibility_reasons,
    parse_placement_conflicts,
)

# ----- bounded numerics (the column is a constraint too) ---------------------

# An event's two numbers are bounded by the COLUMN whether the schema says so or
# not, and for a while only the column said so: ``max_players`` was ``int, gt=0``
# over an ``Integer`` column, ``entry_fee`` was ``float, ge=0`` over a
# ``Numeric(8, 2)``. A player limit of ``9999999999`` satisfies every rule Pydantic
# stated, sailed through the boundary, and detonated in the driver — Postgres
# refused the out-of-range value and the API answered **500**. An organizer typed a
# number into a box and got a server fault.
#
# A boundary that admits what the interior cannot hold is not a boundary. These two
# aliases are the bounds, declared once and shared by the create and the patch
# schemas, because "the patch path is the hole" is the same bug wearing a different
# verb: a value that cannot be created must not be reachable by editing either.
# Sharing the alias is what makes them impossible to drift apart.

MAX_EVENT_PLAYERS = 512
"""The ceiling on an event's player limit — the same 512 the web client's form
enforces (`web-client/src/components/tournaments/data/event-validation.ts`), and the
same number its Basics tab has always *shown* (`<Input type="number" max={512}>`).

512 is a bound with a reason: a 512-player draw is nine rounds of single elimination,
more entrants than the largest table-tennis open in the country, and comfortably
inside the column. It is deliberately **not** the column's own limit (2,147,483,647):
a number only a database could love is not a limit — it is the absence of one, and it
would still let an organizer author an event of two billion players. The two layers
name the same number on purpose; a client-side bound the server did not share would
be a rule the API never made, and a server bound the client did not know would be a
422 landing in a banner instead of under the field."""

EventMaxPlayers = Annotated[int, Field(gt=0, le=MAX_EVENT_PLAYERS)]
"""An event's player limit: a whole number the ``Integer`` column can actually hold,
from 1 (an event of nobody is not an event) to ``MAX_EVENT_PLAYERS``."""

MAX_ENTRY_FEE = 999_999.99
"""The largest fee the ``entry_fee Numeric(8, 2)`` column can hold: six digits before
the point, two after. One cent more is a ``numeric field overflow`` from Postgres —
the same 500 the player limit was."""

_CENTS = Decimal("0.01")


def _fits_the_fee_column(value: float) -> float:
    """Refuse a fee with more than two decimal places, rather than let it round.

    ``Numeric(8, 2)`` holds cents, and Postgres does not complain about a third
    decimal — it silently **rounds** it. So a fee of ``45.005`` is stored as a number
    the organizer never typed (measured: the old schema answered ``201`` and put
    ``45.01`` in the column), read back as that other number, and charged as that
    other number, with nothing anywhere reporting the change. That is not a crash, so
    it is not what the 500 was about — it is the quieter half of the same fault: a
    boundary that rewrites its input is worse than one that refuses it, because the
    caller cannot see what it now holds. A fee is a price and a price is exact, so
    this is a 422 and the organizer gets to say which number they meant.

    The scale is also why the magnitude bound is ``le=999_999.99`` — the largest
    storable fee, exactly — rather than an exclusive ``< 1_000_000`` that looks
    equivalent and is not: ``999999.999`` is under a million, and rounds *up* to
    ``1000000.00``, which overflows the column's precision. Together, ``ge=0`` +
    ``le=MAX_ENTRY_FEE`` + this validator admit exactly the values the column stores
    exactly.

    The float is read through ``str`` (its shortest round-trip repr) so that what is
    judged is the number the client actually wrote — ``45.10`` is two places, not the
    binary tail of 10.1.
    """
    fee = Decimal(str(value))
    if fee != fee.quantize(_CENTS, rounding=ROUND_DOWN):
        raise ValueError(
            f"An entry fee is in whole cents: at most 2 decimal places (got {value})."
        )
    return value


EventEntryFee = Annotated[
    float,
    # ``allow_inf_nan=False``: JSON is not the only thing on the wire — Python's
    # ``json.loads`` (which Starlette parses the body with) happily reads the bare
    # tokens ``Infinity`` and ``NaN``, and an infinite fee passes ``ge=0``. It is not
    # a number the column can hold, so it is refused here rather than in the driver.
    Field(ge=0, le=MAX_ENTRY_FEE, allow_inf_nan=False),
    AfterValidator(_fits_the_fee_column),
]
"""An event's entry fee: a non-negative amount in whole cents that the
``Numeric(8, 2)`` column can hold. ``0`` is a real answer — a free event."""

# ----- value-objects (typed JSONB) -----------------------------------------

ValueObjectId = Annotated[str, Field(min_length=1)]
"""The **identity** of a JSONB value-object — a pool, a table in the venue catalogue.

These ids are *string refs*, not foreign keys: pools and tables have no tables of their
own, so a pool is addressed by a client-supplied string and nothing in the database
constrains it. That is precisely why the constraint has to be stated *here*: the empty
string is not an identity, and it was a **representable** one — ``Pool(id="")``
validated, and an event could be created and patched holding it.

It is not a theoretical illegal state. A fixture names its pool by this string
(ADR-0786) and the rest of the system asks two questions of that ref, which an empty id
answers *inconsistently*: "is this fixture pooled?" is ``pool_id is not None`` — and
``""`` is not ``None``, so **yes** — while the sort that orders a draw's fixtures reads
``pool_id or ""`` (``app.draws.ready_fixtures``), where ``""`` is indistinguishable from
the un-pooled group it deliberately sorts apart. One fixture, pooled by one rule and
un-pooled by the other, and a draw whose order depends on which one you ask. A ``str``
with no floor admits that state; a ``min_length=1`` makes it unsayable — at the
boundary, in the type, rather than as a runtime check downstream (api/CLAUDE.md, "make
illegal states unrepresentable").

Unlike the pool-id *uniqueness* rule (``_pool_ids_are_unique``, an ``AfterValidator``
that contributes nothing to the JSON schema), this **does** change the OpenAPI shape:
``minLength: 1`` is a real JSON-schema keyword, so the generated clients learn the rule
too — which is a feature. A rule the client can express is a rule the organizer meets
under the field instead of in a 422."""


class AddressInput(BaseModel):
    """The venue address a client **sends** on a write (create/edit).

    Six free-text components and **no coordinates**: coordinates are geocoded
    server-side at write time and are never supplied by a client (ADR "a venue's
    coordinates are geocoded server-side at write time and are NOT NULL"). A client
    that tries to send ``latitude``/``longitude`` gets a 422 — ``extra="forbid"`` —
    rather than an unverified number the server would have to trust or re-check.

    The write verbs geocode this input and construct the stored :class:`Address`
    (with coordinates) before persisting; this is the shape on the *request*
    schemas, and :class:`Address` is the shape on the *read* schemas."""

    model_config = ConfigDict(extra="forbid")

    venue: str
    street: str
    city: str
    region: str
    postal: str
    country: str


class Address(BaseModel):
    """A tournament venue address as **stored and read**. A JSONB value-object.

    The six free-text components a client sends (:class:`AddressInput`) **plus**
    the ``latitude``/``longitude`` the server geocoded at write time — both NOT
    NULL (ADR "a venue's coordinates are geocoded server-side at write time and are
    NOT NULL"). Coordinates live inside the JSONB value-object, so the stored
    address always carries them; a read that validates the column into this model
    can rely on non-null coordinates rather than threading ``Optional[float]``
    through every downstream reader.

    This is the shape on the *read* schemas (:class:`TournamentRead` and the
    detail/dashboard reads); the write schemas take :class:`AddressInput`, which
    has no coordinates."""

    model_config = ConfigDict(extra="forbid")

    venue: str
    street: str
    city: str
    region: str
    postal: str
    country: str
    latitude: float
    longitude: float


class GeocodePreview(BaseModel):
    """The result of the read-only address-preview lookup (``GET /v1/geocode``).

    The coordinates a free-text address string resolves to, plus the provider's
    canonical ``formatted`` label, so the web "Preview location" pin can drop a
    marker (and echo the normalized address it matched) *before* the tournament
    write. This is not stored — it is a live lookup through the same injected
    :class:`~app.geocoding.Geocoder` the create/edit write path geocodes with, so
    the pin the previewer sees matches the coordinates a subsequent write records.

    An address that resolves to zero candidates is a coded ``409`` carrying the same
    ``address_not_geocodable`` code the write path answers with — never a
    coordinate-less preview."""

    model_config = ConfigDict(extra="forbid")

    latitude: float
    longitude: float
    formatted: str


def _is_iana_timezone(value: str) -> str:
    """Refuse a timezone that names no real IANA zone (422 at the boundary).

    A tournament's times are wall-clock *intents* anchored to real instants by this
    zone (ADR "tournament times are timezone-aware instants"): the solver composes
    ``(date, start, end, timezone)`` into an instant with stdlib ``zoneinfo``, and a
    display renders it to a venue-local label. A string that ``ZoneInfo`` cannot load
    would detonate deep in that composition — every read and every solve — so it is
    refused *here*, once, rather than let a bad zone reach the column and fail far from
    its source (parse-at-boundaries, api/CLAUDE.md).

    ``ZoneInfo`` raises ``ZoneInfoNotFoundError`` (a ``KeyError``) for an unknown key
    and ``ValueError`` for a malformed one (an empty string, a path-traversal attempt);
    both are the same "not a zone" fault to a caller, so both become one 422.
    """
    try:
        ZoneInfo(value)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise ValueError(
            f"{value!r} is not a known IANA timezone (e.g. 'America/Chicago')."
        ) from exc
    return value


EventTimezone = Annotated[str, Field(min_length=1), AfterValidator(_is_iana_timezone)]
"""An event's venue timezone: an IANA zone name (e.g. ``America/Chicago``) that
ANCHORS the event's wall-clock ``Slot`` windows to real instants (ADR "tournament
times are timezone-aware instants").

It does **not** reshape those windows — a ``Slot`` stays ``{date, start, end}``
wall-clock strings — it is the frame they are read in. ``min_length=1`` gives the empty
string a
clean under-the-field message and a real ``minLength`` in the OpenAPI schema; the
``AfterValidator`` then refuses any string that is not a loadable zone, so an unknown or
malformed zone is a 422 rather than a value the solver/display cannot compose.

Shared verbatim by the create and update schemas so the rule cannot drift between the
two verbs, exactly as ``EventMaxPlayers`` and ``EventPools`` are."""


class Slot(BaseModel):
    """A date-only (``YYYY-MM-DD``) window with ``HH:MM`` start/end. The strings
    are kept as-is to mirror the front-end prototype's wire shape."""

    model_config = ConfigDict(extra="forbid")

    date: str
    start: str
    end: str


class MatchSettings(BaseModel):
    """Per-event match rules: rated flag + game count."""

    model_config = ConfigDict(extra="forbid")

    rated: bool
    length_games: Literal[1, 3, 5, 7]


RatingComparisonOp = Literal["<", "<=", ">", ">=", "=", "!="]
"""The operators that compare a rating against a single number."""

PredicateOp = Literal["<", "<=", ">", ">=", "=", "!=", "between"]
"""Every operator a rule may use: the six comparisons, plus the two-bound
``between``. A closed set, so the evaluator (``app.tournament_eligibility``) can
be a **total** function of it — an operator it has never heard of cannot reach it,
because the boundary refuses one (422)."""


class Predicate(BaseModel):
    """An eligibility rule. ``field`` names the one fact we actually hold about a
    player — their rating on the tournament's league (ADR-0783) — so ``value`` is a
    number, or a ``[min, max]`` pair for the ``between`` operator (either bound may
    be `null`, for an open-ended range). Rules are **ANDed**: a player enters only
    by satisfying every one of them, and `app.tournament_eligibility` is the single
    place that decides that — for the entry guard and for the page that explains
    itself, so the two cannot drift.

    A rule whose `value` is `null` is one the organizer has not finished writing.
    It is storable (an event may be saved mid-edit) and it **constrains nobody**:
    there is no number to compare against, so it admits everyone rather than
    silently barring the whole field on a half-typed rule.

    `op` and `value` are closed domains, not open ones: an unknown operator, a
    `between` given a single number, a `<` given a pair, and a `between` whose pair
    is not exactly two bounds are all **422 at the boundary**. The evaluator is
    therefore total over what it can be handed — a rule it could not decide cannot
    be stored, which is the same reasoning that removed `age`/`gender`/`club` from
    `field`: no such attribute exists on a player, so a rule over one could never be
    evaluated, and an event that advertised it was lying to the players it claimed
    to filter. Naming a removed field is a 422 on create *and* on patch. They return
    with the ticket that gives a player a date of birth, a gender and a club."""

    # ``strict``, so lax coercion cannot smuggle a non-rating in as a rating: without
    # it Pydantic reads ``"1500"`` and ``true`` as the number 1500, and a rule of
    # ``rating < true`` — nonsense that the gender/club fields used to make sayable —
    # would quietly become a working cap. A rating is a number; a string that looks
    # like one is a client bug worth a 422 (api/CLAUDE.md, "consider ``strict=True``
    # for inbound types").
    model_config = ConfigDict(extra="forbid", strict=True)

    id: str
    field: Literal["rating"]
    op: PredicateOp
    # A single number, a ``[min, max]`` pair (for ``between``), or ``null`` — the
    # rule the organizer has not filled in yet. ``str``/``bool`` used to be arms of
    # this union and are gone with the fields that needed them (a gender was a
    # string, a club a bare boolean): a rating is a number, and nothing else is a
    # rating.
    value: int | list[int | None] | None

    @model_validator(mode="after")
    def _value_fits_the_operator(self) -> "Predicate":
        """The pairing of ``op`` and ``value``, enforced here so nowhere else has to.

        ``between`` takes a pair and a comparison takes a number; the cross products
        (``between: 1500``, ``<: [1200, 1500]``, ``between: [1, 2, 3]``) are nonsense
        that the evaluator would have to invent an answer for — and inventing one
        means either admitting a player a rule meant to bar, or barring one it meant
        to admit. Refused at the boundary instead, so the state never reaches the
        column and the evaluator never meets it.
        """
        if self.op == "between":
            if self.value is not None and not isinstance(self.value, list):
                raise ValueError(
                    "`between` takes a [min, max] pair of bounds, not a single number."
                )
            if isinstance(self.value, list) and len(self.value) != 2:
                raise ValueError(
                    "`between` takes exactly two bounds — [min, max] — either of "
                    "which may be null for an open-ended range."
                )
        elif isinstance(self.value, list):
            raise ValueError(
                f"`{self.op}` takes a single number, not a [min, max] pair."
            )
        return self


class TournamentTable(BaseModel):
    """A physical table in the venue catalogue, referenced by id from pools.

    Its ``id`` is a ``ValueObjectId`` for the same reason a pool's is: a pool holds a
    list of these strings (``table_ids``) and nothing else connects the two, so an id
    that is the empty string is a table nothing can name — and a ``table_ids`` entry of
    ``""`` would "resolve" against it. It is the same string-ref pattern with the same
    hole, and closing it in one place and not the other would leave the boundary
    half-drawn.
    """

    model_config = ConfigDict(extra="forbid")

    id: ValueObjectId
    label: str
    court: str


class Pool(BaseModel):
    """A slice of tables reserved for a window of time within an event.

    Its ``id`` is the pool's **identity**: a fixture names the pool it was drawn into
    by that string (ADR-0786), and the pool-set freeze is a rule about the *set* of
    these ids. Which is only a coherent thing to say if an id names one pool — see
    ``EventPools``, the type the event's list of them actually has — and if an id is a
    thing at all, which is what ``ValueObjectId`` says: the empty string is not one, and
    a fixture drawn into it is pooled by one rule and un-pooled by another.

    Its ``name`` has the same floor for the plainer reason: a pool is *called*
    something — it is what the director clicks, what the conflict warnings quote, and
    what a player reads off a wall. ``""`` is not a name, and an event whose pools list
    is three blank rows is not a thing anyone could act on.
    """

    model_config = ConfigDict(extra="forbid")

    id: ValueObjectId
    name: str = Field(min_length=1)
    slot: Slot
    table_ids: list[str]


def named_list(names: list[str]) -> str:
    """The things a refusal is about, as a human would say them: ``“Pool B”``, or
    ``“Pool B” and “Pool C”``, or ``“Pool B”, “Pool C” and “Pool D”``.

    One formatter for every refusal that names a *set* of things — this module's 422s
    (a duplicated pool id) and ``app.tournaments``' 409s (the pool-set freeze's pools,
    the go-live precondition's events) alike — so a director cannot tell, from the
    punctuation, which layer refused them.

    They are named by **name**, never by id. The ids are what the guards actually
    compared, but "pool p-b7f2 cannot be removed" (or "event 3f9c-… has no draw") tells
    a director looking at a page of named pools and named events nothing to act on.

    It lives *here*, at the boundary, because the boundary is the lower layer: a
    validator on ``EventPools`` runs before any route does, and ``app.tournaments``
    already imports this module (the reverse import would be a cycle).
    """
    quoted = [f"“{name}”" for name in names]
    if len(quoted) == 1:
        return quoted[0]
    return f"{', '.join(quoted[:-1])} and {quoted[-1]}"


def _pool_ids_are_unique(pools: list[Pool]) -> list[Pool]:
    """Refuse an event's pools when two of them claim the same ``id`` (422).

    A pool id is an **identity**, and everything downstream of these value-objects is
    built on the assumption that it identifies one pool. Nothing enforced it: pools are
    JSONB with client-supplied string ids, there is no pools table and so no unique
    index, and ``[A, A]`` was stored verbatim (measured: **201**). The bill arrived at
    the cut, which deals the field across the event's pool ids and writes a fixture per
    pairing — two pools with one id deal onto the same ``(event_id, pool_id, round,
    position)``, the fixture table's unique constraint fires, and the director gets a
    **500** from the driver
    (``uq_tournament_fixtures_event_id_pool_id_round_position``, reproduced before this
    validator existed). A boundary that admits what the interior cannot hold is not a
    boundary.

    It is a rule about the **list**, not about a ``Pool``, so it is a validator on the
    list type — and it is stated **once**, on the alias both write schemas share, for
    the reason the numeric bounds are shared (see ``EventMaxPlayers``): "the patch path
    is the hole" is the same bug wearing a different verb. Guarding only ``create``
    would leave the event to be born clean and then edited into the 500 — and the patch
    path is the *worse* of the two, because the pool-set freeze that protects a cut draw
    compares **sets**: ``[A, A, B]`` against a cut event holding ``{A, B}`` is the same
    set, so the freeze waved it through (measured: **200**) and the next cut died. The
    guard that exists to protect the draw was admitting the payload that poisons it.

    The duplicated **ids** are named, not the pools' names: an id is what is duplicated,
    two pools sharing one id may well have different names, and the id is what the
    director must edit. The refusal is a 422 rather than a 409 because this is a
    malformed payload in any state the event could possibly be in — an event with no
    draw at all still cannot have two pools called ``p-a``.
    """
    counted = Counter(pool.id for pool in pools)
    duplicated = [pool_id for pool_id, count in counted.items() if count > 1]
    if duplicated:
        raise ValueError(
            f"A pool id identifies one pool: {named_list(duplicated)} "
            f"{'is' if len(duplicated) == 1 else 'are'} used by more than one pool of "
            "this event. Give each pool an id of its own."
        )
    return pools


EventPools = Annotated[list[Pool], AfterValidator(_pool_ids_are_unique)]
"""An event's pools: any number of them, no two sharing an ``id``.

Shared verbatim by ``TournamentEventCreate`` and ``TournamentEventUpdate``, so the
uniqueness rule cannot drift between the two verbs — sharing the alias is what makes
them impossible to drift apart, exactly as it is for ``EventMaxPlayers``.

An ``AfterValidator``, deliberately: it runs on the parsed ``list[Pool]`` (so it reads
``pool.id``, not ``pool["id"]``) and it contributes **nothing** to the JSON schema, so
the OpenAPI shape of ``pools`` is unchanged and the generated clients keep the array
they already had. A rule a client cannot express in a schema keyword is not a reason to
let the server hold a state it cannot survive."""


# ----- read models ----------------------------------------------------------


class EventEntryOpen(BaseModel):
    """The event itself has nothing against you: it has room, and your rating on the
    tournament's ladder satisfies every rule it has.

    NOT "you can click Enter right now" — the registration *window* is a fact about
    the **tournament** (its status, ADR-0017) and your own membership is a fact about
    the **entrants list**, and both are already on this payload. See
    ``TournamentEventRead.entry_state``."""

    state: Literal["open"] = "open"


class EventEntryFull(BaseModel):
    """The event holds ``max_players`` active entrants already, so nobody may enter it
    — the one arm of this union that says nothing about who is asking.

    Transient: a withdrawal frees a slot (ADR-0016), which is why the entry route
    refuses it with a 409 rather than a 403.

    An **uncapped** event (``max_players`` is ``null``, ADR-0935) is never in this
    state, however many players enter it: there is no limit for the field to reach.
    ``event_is_full`` is the single place that says so, and both this read and the
    entry route's 409 ask it."""

    state: Literal["event_full"] = "event_full"


class EventEntryRatingIneligible(BaseModel):
    """Your rating on the tournament's ladder fails one of the event's rules — the
    *first* one it fails (rules are ANDed, ADR-0783).

    It carries exactly the two facts a client needs to say something honest, and
    nothing else:

    * ``predicate_id`` — WHICH rule refused you. It addresses a rule in this same
      event's ``predicates``, which the client already has and already renders as
      chips, so the page can point at the one that is in the way. Repeating the
      rule's ``op``/``value`` here would be carrying a field *and its own
      derivation* (api/CLAUDE.md), and the two copies could disagree.
    * ``rating`` — the number you were judged on. The client cannot derive it: a
      player's rating on the tournament's league is not otherwise on this page, and
      "you are not eligible" without it is a fact the player cannot act on.

    **No sentence.** The refusal is a state, not prose: the client owns the copy
    (ADR-0968), and a raw API string must never reach the UI. The words that the
    *entry route's* 409 falls back on are built from these same two facts by
    ``app.tournament_eligibility``.

    A player with **no rating** on the ladder is never in this state — they pass every
    rule (ADR-0783 §3), so ``rating`` here is always a real number."""

    state: Literal["rating_ineligible"] = "rating_ineligible"
    predicate_id: str
    rating: float


EventEntryState = Annotated[
    EventEntryOpen | EventEntryFull | EventEntryRatingIneligible,
    Field(discriminator="state"),
]
"""Whether the CALLING user may enter this event — a sum type, not a bag of booleans.

A discriminated union, so the client switches on ``state`` and every arm carries
exactly what that arm needs (``predicate_id``/``rating`` exist only where they mean
something). ``full: bool`` + ``ineligible: bool`` + ``reason: str | None`` would make
"full and eligible and no reason" and "not full but ineligible with no rule"
constructible; here they are not (api/CLAUDE.md, "no tri-state booleans for what is
really a sum type").

The state names are the entry route's **refusal codes** (``EntryRefusal``,
ADR-0968) — the same word for the same fact, so a client can hold one copy table for
"why you cannot enter" whether it learned it from this read or from a 409 it got back
from ``POST …/entries``.
"""


class TournamentEntrantRead(BaseModel):
    """One *active* entry in an event. Withdrawn entries are not entrants: they
    appear in neither this list nor the ``entered`` count.

    ``id`` is the *entry's* id, not the player's: it is the address a client
    withdraws through (``DELETE …/entries/{entry_id}``), so an entrant that a
    client can see is an entrant it can act on.
    """

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    user_id: uuid.UUID
    username: str
    seed: int | None
    # This player's rating on the TOURNAMENT's ladder (its ``league_id``, ADR-0783) —
    # the same number, from the same ladder, that the event's rules judged them by. It
    # is not their rating "in general": a rating is meaningless without the league it
    # was earned in, and the one that matters here is the one the event caps.
    #
    # ``None`` means **Unrated**: we hold no rating for this player on this ladder.
    # That is not an absent number to be filled in later — it is the state ADR-0783 §3
    # is about. An unrated player passes every rating rule, which makes a rating cap
    # opt-out (never play a rated match, remain eligible for every capped event), and
    # the agreed mitigation is that the one person who can act on it — the director,
    # who may withdraw them — can SEE it. An invisible loophole and a visible one are
    # different things, and this field is the difference.
    #
    # It is ``is_rated_member()``'s "no rating", NOT ``rating_value IS NULL``: joining a
    # league SEEDS a 1500 row, so a brand-new player already has a ``rating_value``, and
    # reporting that here would print a confident 1500 next to the very entrant the
    # director is scanning for — the marker would be a lie precisely where it matters.
    rating: float | None


class FixtureTimeRead(BaseModel):
    """One displayed fixture time, shaped so no client does ANY timezone math
    (ADR "tournament times are timezone-aware instants" — "all timezone arithmetic
    lives on the server; clients stay tz-math-free").

    The same moment, carried two ways for two different jobs:

    * ``local_label`` + ``tz_abbrev`` — the moment already rendered in the **event's
      venue timezone** with stdlib ``zoneinfo``, server-side, for a human to READ: a
      12-hour wall-clock label (e.g. ``"6:00 PM"``) and its timezone abbreviation
      (e.g. ``"CDT"``). A client displays ``f"{local_label} {tz_abbrev}"`` verbatim —
      it never slices a datetime or picks a zone. ``tz_abbrev`` rides alongside the
      label because a tournament-wide schedule can put fixtures from different venue
      timezones on one timeline, and each rendered time must name its frame so equal
      columns do not imply simultaneity across frames (ADR "a schedule surface always
      labels the timezone").
    * ``instant`` — the same moment as an unambiguous, offset-bearing ISO-8601
      timestamp, for GEOMETRY: Gantt bar positions are tz-agnostic *differencing*,
      which a client does on instants with no timezone library. It is always
      **normalized to UTC** (``+00:00``) on the way out, so every read path — a detail
      GET, a placement PATCH echo — emits the identical string for the identical
      moment (asyncpg hands ``timestamptz`` back as UTC; an in-memory venue-offset
      value like ``-05:00`` for the same instant is re-normalized here, so the two
      never diverge as strings).

    Carrying both is *not* carrying a field and its own derivation (api/CLAUDE.md):
    the label is for reading and the instant is for math, and neither is derivable
    from the other **without** the timezone library this model exists to keep off the
    client. ``null`` (on the field that holds this model) means the time is
    unassigned — a fact, never a missing value to fill in.
    """

    model_config = ConfigDict(frozen=True)

    #: The moment, as an offset-aware ISO-8601 timestamp normalized to UTC (``+00:00``).
    #: For client-side geometry (bar positions) only — display uses ``local_label``.
    instant: datetime
    #: The moment rendered in the event's venue timezone as a 12-hour wall-clock label
    #: (e.g. ``"6:00 PM"``), no leading zero, no timezone suffix — pair it with
    #: ``tz_abbrev`` for display.
    local_label: str
    #: The venue timezone's abbreviation at that instant (e.g. ``"CDT"``, ``"CST"`` —
    #: DST-correct, resolved by ``zoneinfo``). Shown next to ``local_label``.
    tz_abbrev: str


class TournamentFixtureRead(BaseModel):
    """One planned pairing of an event's draw (ADR-0786): a round and a position —
    plus a pool, when the draw is pooled — whose sides may still be unknown.

    A fixture is **not** a match. It materializes into one at go-live (#788): once the
    tournament is ``live``, every ready fixture becomes a real ``in_progress`` match and
    gains a ``match_id``. Until then ``match_id`` (and ``match_status``) is ``null``.

    **Every ``null`` on this model is a fact, not a missing field**, and a client that
    dropped them would lose the draw's whole point:

    * ``entry_a_id`` / ``entry_b_id`` — ``null`` means **TBD**: the feeding fixture has
      not been decided yet, and ``advance()`` will fill this side in. It never means a
      bye — a bye is the *absence of a fixture row*, not a fixture with an empty side
      (ADR-0786), so there is no ``is_bye`` flag here to tell the two apart.
    * ``winner_entry_id`` — ``null`` while the fixture is undecided.
    * ``match_id`` — ``null`` until the fixture becomes a real match, which only happens
      once the tournament is ``live``. When set, it is the id of the match the slot
      links to (``GET /v1/matches/{match_id}``), so a client can deep-link a slot.
    * ``match_status`` — the live status of that match (``in_progress`` at go-live,
      moving to ``completed`` / ``voided`` as it is played), or ``null`` when the
      fixture has not materialized. It rides on the fixture so a bracket shows a slot's
      state without a per-slot round-trip; it is the match's *current* status, read
      live, not a copy frozen at go-live.
    * ``pool_id`` — ``null`` means this fixture belongs to no pool: the draw is
      un-pooled (single-elim), or this is the knockout stage of a future
      pools-then-knockout draw type. When
      set, it names a ``Pool`` in this same event's ``pools`` — a string ref into
      JSONB, not a foreign key, because pools are value-objects with no table.
    * ``table_id`` — the fixture's **placement** table (ADR-0790): ``null`` means
      **unassigned to a table**. When set, it names a ``TournamentTable`` in the
      tournament's ``table_catalogue`` — a string ref into JSONB, not a foreign key,
      the same pattern as ``pool_id``.
    * ``scheduled_start`` — the placement's **predicted** start: ``null`` means
      **unscheduled**. When set, a :class:`FixtureTimeRead` (see it) — a venue-local
      label + tz abbrev for display, plus the raw UTC instant for geometry — composed
      server-side in the event's timezone (ADR "tournament times are timezone-aware
      instants", superseding ADR-0790's naive-wall-clock frame). A prediction rather
      than a commitment — a match starting off-prediction is normal, not an error.
    * ``pinned_at`` — when the fixture was **called** (ADR "the schedule is solved,
      the call is pinned"): ``null`` means the placement is still an estimate the
      solver may move freely. When set, the placement is a promise — the players were
      notified, and no later solve will rearrange it — carried as a
      :class:`FixtureTimeRead` in the event's timezone, like ``scheduled_start``.
    * ``completed_at`` — the match's **actual** completion time, as opposed to
      ``scheduled_start``'s *predicted* one: ``null`` until the match is actually
      decided (win or void), then the moment it was, as a :class:`FixtureTimeRead`.
      This is the value a Gantt-style schedule view should use as a played slot's real
      end, instead of projecting ``scheduled_start + an estimated duration`` past a
      match that has already finished. All three times share the one
      :class:`FixtureTimeRead` shape — a UTC ``instant`` for tz-agnostic arithmetic
      (e.g. a bar's width) and a pre-rendered venue-local label — so a client juggles
      no timezones itself, even though ``Match.completed_at`` is stored as an ordinary
      UTC timestamp and the two placement columns are venue-anchored instants.

    The entries are carried as **ids only**. The name and username behind
    ``entry_a_id`` are already on this page — the event's ``entrants`` list carries
    them, keyed by that very id — so a client joins the two. Copying the username onto
    the fixture as well would be carrying a field and its own derivation
    (api/CLAUDE.md), and the copy that drifts is the one a player reads off a bracket.
    """

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    pool_id: str | None
    round: int
    position: int
    entry_a_id: uuid.UUID | None
    entry_b_id: uuid.UUID | None
    winner_entry_id: uuid.UUID | None
    match_id: uuid.UUID | None
    # The linked match's live status, or ``null`` when the fixture has not materialized.
    # Read from the match row on every load (never snapshotted), so it tracks the match
    # as it is played rather than freezing at go-live. See ``match_id`` above.
    match_status: MatchStatus | None
    # A placement. ``table_id`` string-refs the tournament's table_catalogue; both it
    # and ``scheduled_start`` ``null`` = unassigned. ``scheduled_start`` is the
    # predicted start as a ``FixtureTimeRead`` (venue-local label + tz abbrev + raw
    # UTC instant), composed server-side in the event's timezone.
    table_id: str | None
    scheduled_start: FixtureTimeRead | None
    # The pin facts (see the docstring): ``pinned_at`` null = estimate, set = promise
    # (a ``FixtureTimeRead``, same shape as ``scheduled_start``);
    # ``call_notified_count`` is how many times the players were told (call +
    # corrections), the number the UI prices a re-drag with.
    pinned_at: FixtureTimeRead | None
    call_notified_count: int
    # The match's actual completion time — ``null`` until it is decided — as a
    # ``FixtureTimeRead`` in the event's timezone (see the docstring). This is the Gantt
    # chart's real end anchor for a played slot, as opposed to ``scheduled_start``'s
    # predicted one.
    completed_at: FixtureTimeRead | None


class ScheduleSolveRead(BaseModel):
    """One row of a tournament's **solve ledger** (ADR "the schedule is solved, the
    call is pinned") — a single run of the placement solver, which the admin page
    reads verbatim.

    ``status`` is the *run's* lifecycle; ``verdict`` is CP-SAT's own answer, and they
    are deliberately separate facts: a run can end ``succeeded`` on a merely
    ``feasible`` verdict (FEASIBLE is accepted under the time cap — mid-tournament we
    want a good answer now, not a proof), and ``infeasible`` is a designed outcome,
    not an error — it is the whole point of pre-live solves.

    **Every ``null`` marks a stage not (or never) reached**, not a missing field:

    * ``verdict`` — ``null`` until the solver has actually run; forever ``null`` for
      a run that failed before reaching it.
    * ``started_at`` / ``finished_at`` — ``null`` while the run is still ``queued`` /
      still ``running``.
    * ``wall_time_ms`` — the solver's wall time; ``null`` until it has finished.
    * ``fixtures_placed`` / ``fixtures_pinned`` — the sizes of the *applied* output;
      ``null`` until (unless) the run reaches its guarded apply. A solve whose output
      was discarded for drift re-runs rather than reporting partial counts — the
      apply is whole-or-nothing.
    * ``error`` — why a ``failed`` run failed; ``null`` on every other status.

    ``overrunning`` is a *success qualifier*, not a status of its own: ``true`` only
    on a ``succeeded`` run whose plan ran a fixture past its pool's **planned** window
    end while the tournament is **live** — the window went soft so the day keeps being
    scheduled into the overrun instead of wedging "doesn't fit" (ADR "the solver stops
    wedging"). Always ``false`` pre-live (the window is a hard constraint) and on any
    run that placed nothing (``infeasible`` / ``failed``). A schedule surface reads it
    to label the day "overrunning".

    ``infeasibility_reasons`` is **never null** — it is always a list, empty on
    every row that is not ``infeasible`` (so a client never null-checks it). An
    ``infeasible`` verdict carries the resolved, DB-humanized reasons the day
    could not be scheduled (pool names, ``HH:MM`` window bounds, the integer
    minutes to format) — including the pre-live ``past_window`` cause (ADR "a
    past day is named, not disguised"), which carries the offending venue-local
    ``date`` to move; every other row carries ``[]``. Parsed from the ledger's
    raw JSONB at this boundary so no downstream reader touches a bare dict.

    ``placement_conflicts`` is **never null** either — always a list, ``[]`` on
    every row without conflicts (so a client never null-checks it). It is
    orthogonal to the verdict: even a fully-*placed* board can flag overlapping
    in-progress matches (two matches on one table, or one human in two at once,
    from a soft manual placement PATCH). It carries the resolved, DB-humanized
    conflicts — table labels and player names, each colliding fixture named by
    its matchup — parsed from the ledger's raw JSONB at this boundary so no
    downstream reader touches a bare dict.
    """

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    trigger: ScheduleSolveTrigger
    status: ScheduleSolveStatus
    verdict: SolverVerdict | None
    requested_at: datetime
    started_at: datetime | None
    finished_at: datetime | None
    wall_time_ms: int | None
    fixtures_placed: int | None
    fixtures_pinned: int | None
    overrunning: bool
    error: str | None
    infeasibility_reasons: list[ResolvedReason]
    placement_conflicts: list[ResolvedConflict]

    @field_validator("infeasibility_reasons", mode="before")
    @classmethod
    def _parse_infeasibility_reasons(cls, value: Any) -> list[ResolvedReason]:
        """Parse the ledger's raw ``infeasibility_reasons`` JSONB
        (``list[dict] | None``) into the typed union at the boundary, mapping the
        NULL of a non-``infeasible`` row to ``[]`` — so ``model_validate`` on a
        ``ScheduleSolve`` row never fails on a null column and no raw dict leaks
        inward. A value already parsed to typed reasons passes back through
        unchanged."""
        return parse_infeasibility_reasons(value)

    @field_validator("placement_conflicts", mode="before")
    @classmethod
    def _parse_placement_conflicts(cls, value: Any) -> list[ResolvedConflict]:
        """Parse the ledger's raw ``placement_conflicts`` JSONB
        (``list[dict] | None``) into the typed union at the boundary, mapping the
        NULL of a row that never reached its apply to ``[]`` — so
        ``model_validate`` on a ``ScheduleSolve`` row never fails on a null
        column and no raw dict leaks inward. A value already parsed to typed
        conflicts passes back through unchanged."""
        return parse_placement_conflicts(value)


class StandingRowRead(BaseModel):
    """One entry's line in a pool's standings (ADR-0788), at its settled rank.

    The entry is carried as an **id only**, exactly as a fixture carries its sides: the
    username behind ``entry_id`` is on the event's ``entrants`` list already, keyed by
    that same id, so a client joins the two rather than reading a copy that could drift.

    ``rank`` is 1-based and distinct per row — the pool's order is total (wins → two-way
    head-to-head → game difference → games won → id), so position 1 is the leader.
    ``game_difference`` (``games_won - games_lost``) rides along because it is the third
    tiebreaker and a client shows it in the table; it is a pure function of the two game
    counts beside it, computed once on the server so the two cannot disagree."""

    entry_id: uuid.UUID
    rank: int
    played: int
    wins: int
    losses: int
    games_won: int
    games_lost: int

    @computed_field  # type: ignore[prop-decorator]  # pydantic: decorate the property, not its getter
    @property
    def game_difference(self) -> int:
        """``games_won - games_lost`` — the third tiebreaker, on the wire for the table
        to show but derived here so it cannot disagree with the two counts beside it."""
        return self.games_won - self.games_lost


class PoolStandingsRead(BaseModel):
    """One pool's standings: its rows in finishing order, and whether every one of its
    fixtures has been decided.

    ``pool_id`` names a ``Pool`` in this same event's ``pools`` — the string ref a
    fixture also carries — so a client titles the table from the pool it already
    holds."""

    pool_id: str
    rows: list[StandingRowRead]
    complete: bool


class StandingsResultsRead(BaseModel):
    """The **standings** shape of an event's results (ADR-0788) — the round-robin arm
    of the ``results`` discriminated union, tagged ``kind: "standings"``.

    A standings table per pool, whether the whole event is decided, and its champion
    when there is one. It rides on the tournament-detail payload (one endpoint per page)
    and is **derived live** from the fixtures' currently-completed matches — never a
    snapshot — so a corrected or voided match re-orders the standings the instant it
    leaves ``completed``.

    ``champion`` is the leader of a **complete, single-pool** event — a pure
    round-robin's winner. A multi-pool round-robin has no single champion without a
    knockout stage to join its pool winners (a pools-then-knockout draw type, a later
    slice), so it is
    ``null`` there even when ``complete``; and ``null`` while any fixture is still to be
    played."""

    # The tag that discriminates the ``results`` union on the wire (ADR-0785): a client
    # switches on ``kind`` — a ``standings`` table here vs. a ``finishes`` list —
    # rather than sniffing which fields are present.
    kind: Literal["standings"] = "standings"
    pools: list[PoolStandingsRead]
    complete: bool
    champion: uuid.UUID | None


class FinishRowRead(BaseModel):
    """One entrant's **finish** in a single-elimination bracket (ADR-0785): its
    finishing position and the round it was eliminated in.

    The entrant is carried as an **id only**, exactly as a standings row and a fixture
    are: the username behind ``entry_id`` is on the event's ``entrants`` list already,
    keyed by that same id, so a client joins the two rather than reading a copy that
    could drift.

    ``position`` is 1-based and **shared by same-round losers** — the two semifinal
    losers both carry ``3``, the four quarterfinal losers ``5`` — so it is deliberately
    *not* distinct per row: single-elimination does not rank same-round losers against
    each other. ``eliminated_in_round`` is the 1-based round the entrant lost in, and
    ``null`` for the champion, never eliminated (their ``position`` is ``1``)."""

    entry_id: uuid.UUID
    position: int
    eliminated_in_round: int | None


class FinishesResultsRead(BaseModel):
    """The **finishes** shape of an event's results (ADR-0785) — the single-elimination
    arm of the ``results`` discriminated union, tagged ``kind: "finishes"``.

    A ranked list of :class:`FinishRowRead` (position ascending, ties sharing a
    position), whether the whole bracket is decided, and its champion when there is one.
    Like every results shape it is **derived live** from the fixtures' completed
    matches, so a correction or void re-derives it (and can re-crown) with no snapshot.

    Only *placed* entrants appear in ``finishes``: every loser of a decided fixture,
    plus the champion once the final is decided. An entrant still alive in a
    partially-played bracket has no finish yet and is simply absent — a partial, live
    result. ``champion`` is the final's winner (position 1) and ``null`` until the final
    is decided."""

    kind: Literal["finishes"] = "finishes"
    finishes: list[FinishRowRead]
    complete: bool
    champion: uuid.UUID | None


# An event's results cross the wire as a **discriminated union tagged by shape**
# (ADR-0785): a round-robin reads out ``standings``, a single-elim reads out
# ``finishes``. Coercing finishes into the standings row shape was rejected — a bracket
# has no wins/game-difference columns, so every such row would carry meaningless
# nullable fields, the tri-state smell ``api/CLAUDE.md`` warns against. Each shape is
# its own model; the client switches on ``kind``.
EventResultsRead = Annotated[
    StandingsResultsRead | FinishesResultsRead, Field(discriminator="kind")
]


class TournamentEventRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    tournament_id: uuid.UUID
    name: str
    format: EventFormat
    draw_type: DrawType
    # ``null`` means the event is uncapped — there is no entrant limit (ADR-0935).
    max_players: int | None
    # Typed ``float`` so JSON emits a number, not a Decimal string. The
    # Numeric(8,2) column coerces cleanly into float at the read boundary.
    entry_fee: float
    # The venue timezone (IANA name) that ANCHORS this event's wall-clock windows to
    # real instants (ADR "tournament times are timezone-aware instants"). It rides on
    # the read so a client (and later the display BFF) knows the frame every ``Slot``
    # of this event is stated in; the ``Slot`` strings themselves are unchanged.
    timezone: str
    slot: Slot
    match_settings: MatchSettings
    predicates: list[Predicate]
    pools: list[Pool]
    created_at: datetime
    updated_at: datetime
    # The event's active entrants, oldest entry first.
    entrants: list[TournamentEntrantRead]
    # Current-user-aware: this is the CALLER's answer to "may I enter this event?",
    # decided server-side against the two facts only the server holds — the event's
    # live entry count against its ``max_players``, and the caller's rating on the
    # tournament's ladder against the event's rules (ADR-0783). The client never
    # re-derives it from the raw ``predicates``: two rule engines in two languages
    # drift, and the moment they do, the page offers an Enter the API refuses.
    #
    # It answers for the EVENT alone, and deliberately does not restate what the page
    # can already see:
    #
    #   * the registration WINDOW is the tournament's status (ADR-0017) — it is on
    #     this payload, and it governs every event of the tournament equally;
    #   * whether you are ALREADY IN is the entrants list above — also on this
    #     payload, and it is what tells Enter from Withdraw.
    #
    # Carrying either of those here would be a field and its own derivation, which is
    # a pair that can disagree (api/CLAUDE.md). So ``open`` means "the event admits
    # you", not "the button is live": the client composes the three.
    entry_state: EventEntryState
    # The event's DRAW: its fixtures, in pool → round → position order (ADR-0786).
    #
    # It rides on this payload rather than on a ``GET …/draw`` of its own, because the
    # tournament-detail page is one page and the repo's BFF rule gives it one endpoint
    # (root CLAUDE.md). A separate draw endpoint would make every event's bracket a
    # second round-trip the page cannot start until this one lands — a suspense
    # waterfall, which is a defect here, not a design.
    #
    # **Empty is the designed state of an event whose draw has not been cut**, not an
    # error and not a ``null``: an event with no draw is the normal condition of every
    # event ever created (cutting is an explicit act, ADR-0786), so it answers ``[]``
    # and the client renders "no draw yet" from a list it can iterate either way.
    fixtures: list[TournamentFixtureRead]
    # The event's RESULTS: a discriminated union tagged by shape (ADR-0785), derived
    # live from the fixtures' completed matches — ``kind: "standings"`` (a per-pool
    # table, ADR-0788) for a round-robin, ``kind: "finishes"`` (a ranked placement list)
    # for a single-elimination bracket. Either fills in as results land and crowns a
    # champion when the last one does. ``null`` for an event with no draw cut (nothing
    # to stand) or one whose draw type has no results strategy yet — round-robin and
    # single-elim have one today. It rides on this same payload for the same
    # one-endpoint-per-page reason ``fixtures`` does: results are part of the
    # tournament-detail page, not a second round-trip.
    results: EventResultsRead | None

    @computed_field  # type: ignore[prop-decorator]  # pydantic wraps the property
    @property
    def entered(self) -> int:
        """The registration count. Derived — there is no stored counter (ADR-0016).

        It is ``len(entrants)`` rather than a field of its own precisely so the
        count and the list it counts cannot disagree: an event that says it has
        52 entrants but lists 51 is not a representable state.
        """
        return len(self.entrants)


class DrawTypeRead(BaseModel):
    """One selectable draw format, as the ``draw_types`` table holds it.

    The rows of this table are the draw formats the product can actually run — a row
    exists exactly when the server has a strategy that can cut and stand that draw (ADR
    "a draw type is a seeded row, and the enum holds only what runs"). So a client
    renders the catalogue it is sent and never keeps a list of its own: a format added
    on the server appears in the picker with no client change, and one the server cannot
    run is never offered in the first place.

    ``name`` and ``description`` are the copy to show — a short label and the sentence
    or two explaining the trade-off a director is choosing between. Both are always
    present and never empty. ``key`` is the value to send back as an event's
    ``draw_type``.
    """

    model_config = ConfigDict(from_attributes=True)

    key: DrawType
    name: str
    description: str
    # The order to render the options in. Ships already applied — the catalogue arrives
    # sorted by it — so a client can iterate the list as given; it is carried so a
    # client that re-sorts (or renders into a grid) can reproduce the intended order
    # rather than inventing one.
    display_order: int


class TournamentRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    description: str | None
    status: TournamentStatus
    start_date: date | None
    end_date: date | None
    address: Address
    table_catalogue: list[TournamentTable]
    # The league whose rating ladder this tournament's eligibility rules are judged
    # on (ADR-0783). Never null: a tournament created without one is run on the
    # default league.
    league_id: uuid.UUID
    created_by_user_id: uuid.UUID
    created_by_username: str
    can_edit: bool
    created_at: datetime
    updated_at: datetime


class TournamentDetailRead(TournamentRead):
    events: list[TournamentEventRead]
    # The tournament's distance from the caller's point, in **miles**, when the list
    # was queried with a ``lat``/``lng``/``radius_miles`` triple (the "near me" filter,
    # ADR "a venue's coordinates are geocoded server-side ... Distance is a haversine
    # expression"). Computed server-side by the same haversine the radius filter uses,
    # so a card can show "12.3 mi away" without the client doing any geo math.
    #
    # ``null`` means **no location was asked for** — the designed state of every read
    # that is not near-me (the unfiltered list, the single-tournament detail read, the
    # MCP owner-scoped list): there is no point to measure from, so there is no
    # distance, and a client renders no "away" badge rather than a bogus zero.
    distance_miles: float | None = None
    # The Schedule tab's solve strip (ADR "the schedule is solved, the call is
    # pinned"): the NEWEST row of the tournament's solve ledger, by ``requested_at``.
    # One row, not the ledger — the strip shows the current run's state (queued /
    # running / succeeded / infeasible / failed) and the counts of the last applied
    # plan; the full history is the admin page's read, not this page's. It rides on
    # this payload for the same one-endpoint-per-page reason ``fixtures`` does.
    #
    # ``null`` means **no solve has ever been requested** for this tournament — the
    # designed state of every tournament until a draw exists and something (go-live,
    # the Run-scheduler button, a completed match) asks for a schedule.
    latest_schedule_solve: ScheduleSolveRead | None
    # The draw formats a director may pick when adding or editing an event on this page,
    # in ``display_order`` — read from the ``draw_types`` table, never derived from the
    # Python enum, because the table is what gates the choice (ADR "a draw type is a
    # seeded row"). It rides on this payload for the same one-endpoint-per-page reason
    # ``fixtures`` and ``latest_schedule_solve`` do: the event form is part of the
    # tournament page, not a second round-trip, and a catalogue fetched separately is a
    # picker that renders empty for one paint.
    #
    # ``null`` means **not projected**, exactly as the LIST's other nulls mean "not
    # computed here" (``distance_miles`` above): the tournament LIST
    # returns this same aggregate but renders no event form, so it skips the query
    # rather than repeating one global two-row catalogue on every card. It is never
    # empty when it is present — there is always at least one runnable draw format.
    draw_type_catalogue: list[DrawTypeRead] | None


# ----- write models ---------------------------------------------------------


class TournamentCreate(BaseModel):
    """A new tournament. It carries **no** ``status``: a tournament is born
    ``draft`` (the column's default) and moves only across a guarded lifecycle
    edge, via ``POST /v1/tournaments/{id}/transitions`` (ADR-0017). Sending a
    ``status`` here is a 422 — ``extra="forbid"`` — rather than a tournament that
    is born ``live``.

    ``league_id`` names the rating ladder the tournament's eligibility rules are
    judged on (ADR-0783). It is optional here and NOT NULL in the database: an
    omitted league resolves to the **default league**, so the caller only names one
    when it means something other than the default. An id that names no league is a
    404 — never a silent fall back to the default, which would run the tournament,
    and judge its entrants, on a ladder nobody chose."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=1024)
    start_date: date | None = None
    end_date: date | None = None
    # The write shape: six free-text components, no coordinates. The verb geocodes
    # it into a stored ``Address`` (with coordinates) before persisting (ADR "a
    # venue's coordinates are geocoded server-side ... and are NOT NULL").
    address: AddressInput
    table_catalogue: list[TournamentTable] = Field(default_factory=list)
    league_id: uuid.UUID | None = None


class TournamentUpdate(BaseModel):
    """Partial update. A field that is *absent* is left unchanged; an explicit
    value replaces the current one. The columns backing ``name``, ``address``,
    and ``table_catalogue`` are NOT NULL, so for those an explicit ``null`` is
    rejected (422) rather than allowed to reach the DB — "omitted" and "cleared"
    are different. ``description``/``start_date``/``end_date`` are nullable
    columns and may be cleared. ``table_catalogue`` replaces wholesale when
    present.

    ``status`` is **not** updatable and is absent here on purpose: the lifecycle
    runs forward only across guarded edges, so the one way it moves is
    ``POST /v1/tournaments/{id}/transitions`` (ADR-0017). A guard on that route
    that left a ``status`` field on this one would have guarded nothing, so
    sending ``status`` here is a 422 via ``extra="forbid"``.

    ``league_id`` is updatable, but **only while the tournament is ``draft``**
    (ADR-0783): once it is published, registration is open and eligibility is live,
    so moving the ladder underneath would silently re-judge players who have
    already entered. That is a state rule, not a shape rule, so it is a 409 from
    the route rather than a 422 from here. Its column is NOT NULL, so an explicit
    ``null`` is rejected."""

    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=1024)
    start_date: date | None = None
    end_date: date | None = None
    # The write shape: six free-text components, no coordinates (see
    # ``TournamentCreate.address``). An explicit ``null`` is rejected below; an
    # omitted key leaves the stored address (and its coordinates) unchanged.
    address: AddressInput | None = None
    table_catalogue: list[TournamentTable] | None = None
    league_id: uuid.UUID | None = None

    @field_validator("name", "address", "table_catalogue", "league_id", mode="before")
    @classmethod
    def _reject_explicit_null(cls, value: Any) -> Any:
        # These map to NOT NULL columns. ``mode="before"`` runs even when the
        # client sends an explicit ``null``; omitting the key entirely skips
        # the validator and keeps the default (the "absent" case).
        if value is None:
            raise ValueError("must not be null")
        return value


class TournamentTransitionCreate(BaseModel):
    """The edge a caller wants the tournament to travel: the status to move *to*.

    ``to`` alone, with no ``from``: the tournament already knows where it is, and
    a client that told us would only be telling us what it *believed* — a stale
    tab's belief at that. The current status is read from the row, and whether the
    (current, ``to``) pair is an edge at all is the server's judgement (ADR-0017).
    """

    model_config = ConfigDict(extra="forbid")

    to: TournamentStatus


class TournamentEntryCreate(BaseModel):
    """*Who* to enter — the body of ``POST …/entries``, and the whole of it.

    **The body is optional, and its presence selects the actor** (ADR-0784):

    * **omitted** → you are entering *yourself*. Self-registration, gated on the
      ``tournament.enter`` permission — the request every player already sends, which
      carries no body at all and must keep working unchanged.
    * **``user_id`` present** → a *director* is entering somebody, which only the
      tournament's **owner** may do.

    One endpoint, not two, because both actors must run the same eligibility
    evaluator, take the same capacity lock and produce the same four refusal codes
    (``EntryRefusal``, ADR-0968). A twin route would make the *next* refusal a thing
    to add twice, and the two call sites of the evaluator a thing to keep from
    drifting.

    Naming **your own** ``user_id`` is self-registration, not a director entry — the
    same guard, and the same ``added_by_user_id = NULL`` on the row. "The player
    entered themselves" has exactly one encoding, and ``added_by == user_id`` is not
    it (see ``TournamentEntry.added_by_user_id``).

    There is deliberately **no ``force``**: a director's entry is refused by the same
    rules a player's is — a full event and a rating cap catch a director's typo exactly
    as they catch a stranger's. Absent an override, that *is* the safety model, and the
    override is a ticket of its own (#985), not a flag smuggled in here.
    """

    model_config = ConfigDict(extra="forbid")

    user_id: uuid.UUID


class TournamentEventCreate(BaseModel):
    """A new event. Its two numbers are bounded by what their columns can hold —
    ``EventMaxPlayers`` and ``EventEntryFee``, shared verbatim with
    ``TournamentEventUpdate`` — so a value that would overflow ``Integer`` or
    ``Numeric(8, 2)`` is a 422 here and never reaches the driver as a 500.

    ``max_players`` is **optional**: omit it (or send ``null``) for an event with no
    entrant cap (ADR-0935). Absent and null mean the same thing here — uncapped —
    because there is nothing else an absent cap could mean on a create. The bound and
    the nullability are orthogonal and both hold: a cap that is *present* is a whole
    number from 1 to ``MAX_EVENT_PLAYERS``."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=255)
    format: EventFormat
    draw_type: DrawType
    # ``None`` (or omitted) is the uncapped event — the "no cap" sentinel of ADR-0935,
    # not a cap of zero. When a cap IS supplied it is an ``EventMaxPlayers``: ``gt=0``
    # (a cap of zero admits nobody, which is not an event) and ``le=512`` (the column
    # is an ``Integer``, and a cap it cannot hold was a 500 from the driver, not a
    # 422). The two rules compose — nullable *and* bounded — and the DB's
    # ``CHECK (max_players > 0)`` backs the positive half of it whatever route writes
    # the row.
    max_players: EventMaxPlayers | None = None
    entry_fee: EventEntryFee
    # Required and validated: the event's wall-clock windows are meaningless without a
    # zone to anchor them (ADR "tournament times are timezone-aware instants"), so a
    # create must name one and it must be a real IANA zone (an unknown zone is a 422).
    # The client derives the default from the browser
    # (``Intl.DateTimeFormat().resolvedOptions().timeZone``) and sends it explicitly —
    # there is no server default, because "the event's venue is UTC" is a guess no
    # single-venue tournament would want silently made for it.
    timezone: EventTimezone
    slot: Slot
    match_settings: MatchSettings
    predicates: list[Predicate] = Field(default_factory=list)
    # ``EventPools``, not ``list[Pool]``: no two of an event's pools may share an ``id``
    # (a fixture names its pool by that string, and a duplicate id 500'd the cut). The
    # same alias the patch schema carries, so the rule holds on both verbs.
    pools: EventPools = Field(default_factory=list)


class TournamentEventUpdate(BaseModel):
    """Partial update for an event. Absent fields are unchanged. Every column
    these fields back except ``max_players`` — ``name``/``format``/``draw_type``/
    ``entry_fee``/``slot``/``match_settings``/``predicates``/``pools`` — is NOT
    NULL, so an explicit ``null`` on any of *those* is rejected (422).
    ``predicates``/``pools`` replace wholesale when present. ``entered`` is not
    updatable — it is derived from the event's active entries, not stored — so
    sending it is a 422 via ``extra="forbid"``.

    ``max_players`` is the one nullable column here, so it is the one field where
    ``null`` and *absent* differ: an explicit ``null`` **clears the cap**, making the
    event uncapped (ADR-0935), while omitting the key leaves the cap alone. That is
    why it is not in the ``_reject_explicit_null`` list below.

    ``max_players`` and ``entry_fee`` otherwise carry the **same** bounds create does —
    the ``EventMaxPlayers``/``EventEntryFee`` aliases, not a second copy of the numbers,
    so a cap the client clears to ``null`` and a cap it sets to ``9999999999`` are
    answered by the same rules on both verbs. A patch that could smuggle in a value
    create refuses would defeat create's boundary entirely: the event would simply be
    born small and then edited into the 500."""

    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=255)
    format: EventFormat | None = None
    draw_type: DrawType | None = None
    max_players: EventMaxPlayers | None = None
    entry_fee: EventEntryFee | None = None
    # The same validated IANA zone create requires — correcting the venue timezone is a
    # supported edit (ADR: "picked Chicago, the venue is Denver"). Its column is NOT
    # NULL, so an explicit ``null`` is rejected below; an unknown zone is still a 422.
    timezone: EventTimezone | None = None
    slot: Slot | None = None
    match_settings: MatchSettings | None = None
    predicates: list[Predicate] | None = None
    # The create schema's pools, exactly: a payload that could smuggle a duplicate id in
    # by PATCH would defeat create's boundary entirely — and it is the patch path the
    # pool-set freeze cannot cover, since it compares SETS and ``[A, A, B]`` is the same
    # set as ``{A, B}``. See ``_pool_ids_are_unique``.
    pools: EventPools | None = None

    @field_validator(
        "name",
        "format",
        "draw_type",
        "entry_fee",
        "timezone",
        "slot",
        "match_settings",
        "predicates",
        "pools",
        mode="before",
    )
    @classmethod
    def _reject_explicit_null(cls, value: Any) -> Any:
        # ``max_players`` is deliberately absent here: it is a nullable column and
        # an explicit ``null`` is meaningful — it clears the cap (ADR-0935).
        if value is None:
            raise ValueError("must not be null")
        return value


def _naive_wall_clock(value: datetime) -> datetime:
    """A placement's ``scheduled_start`` arrives on the wire as a **naive** venue
    wall-clock timestamp (what the director typed, e.g. "18:00"), in the event's
    local frame (ADR "tournament times are timezone-aware instants"). The server
    anchors it to a real instant via the event's ``timezone``
    (``anchor_wallclock`` does ``naive.replace(tzinfo=...)``, which requires a
    naive input) before it is stored in the ``timestamptz`` column.

    So an offset-**aware** value is a client bug: the wire contract is a naive
    wall-clock the server anchors, and a value that carries its own timezone is
    both redundant with the event's frame and un-anchorable by
    ``anchor_wallclock`` (``replace(tzinfo=...)`` on an already-aware value would
    silently discard the offset). It is refused *here*, at the boundary (422),
    rather than leaking inward. Same reasoning as the fee/player-limit bounds
    above: a boundary that admits what the domain cannot honestly represent is not
    a boundary. This is a representational floor, not one of the *soft* placement
    constraints (table-in-pool, time-in-window, no double-booking) ADR-0790 keeps
    off the write path — those still save.
    """
    if value.tzinfo is not None:
        raise ValueError(
            "scheduled_start is a naive wall-clock time (no timezone), in the venue's "
            "local frame."
        )
    return value


PlacementStart = Annotated[datetime, AfterValidator(_naive_wall_clock)]
"""A placement's predicted start: a naive venue wall-clock ``datetime`` the server
anchors to an instant via the event's timezone (ADR "tournament times are
timezone-aware instants"). The ``AfterValidator`` refuses an offset-aware value (422),
which the naive-anchoring contract cannot honestly represent; it contributes nothing to
the JSON schema, exactly like ``_fits_the_fee_column``."""


class TournamentFixturePlacementUpdate(BaseModel):
    """A fixture's **placement** (ADR-0790): the table it sits at and its predicted
    start.

    The body is the placement in full — both fields are stated together. ``null`` on
    either clears that half, and ``(null, null)`` unassigns the fixture entirely.

    **Soft, deliberately.** ``scheduled_start`` is a *prediction*, not a commitment,
    and the placement's constraints — the table belongs to the fixture's pool, the time
    falls inside the pool's window, nothing is double-booked — are **flags derived on
    read, not invariants** (ADR-0790). So this write does **not** reject an
    out-of-window time, nor a ``table_id`` that names no table in the tournament's
    ``table_catalogue`` (a later pool/catalogue edit can dangle the ref; that is a
    flag-on-read concern). They save. Conflict detection is a future scheduler slice.

    ``table_id`` is a **string ref** into the tournament's ``table_catalogue`` (names a
    ``TournamentTable.id``) — the same pattern as a fixture's ``pool_id``, not a
    foreign key — and per the soft rule above an unknown id is stored, not refused.

    The one thing the *route* refuses is moving a fixture whose linked match is
    ``completed`` or ``voided``: its placement is history (409). A fixture with no match
    yet, or an ``in_progress`` one, is freely (re)placeable.

    Soft against *validation* — but not weightless: a manual placement is a **pin**
    (ADR "the schedule is solved; the call is pinned"). A full placement of a fixture
    whose entrants are known sets ``pinned_at`` — a commitment the solver schedules
    around — and, while the tournament is live, notifies both players (the route
    docstring has the full call/moved/cancelled semantics). Anything less than a full
    placement unpins.
    """

    model_config = ConfigDict(extra="forbid")

    table_id: str | None
    scheduled_start: PlacementStart | None

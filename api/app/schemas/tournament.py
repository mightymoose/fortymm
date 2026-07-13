import uuid
from collections import Counter
from datetime import date, datetime
from decimal import ROUND_DOWN, Decimal
from typing import Annotated, Any, Literal

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    computed_field,
    field_validator,
    model_validator,
)

from app.models.tournament import DrawType, EventFormat, TournamentStatus

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


class Address(BaseModel):
    """A tournament venue address. Stored as a JSONB value-object."""

    model_config = ConfigDict(extra="forbid")

    venue: str
    street: str
    city: str
    region: str
    postal: str
    country: str


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
    """A physical table in the venue catalogue, referenced by id from pools."""

    model_config = ConfigDict(extra="forbid")

    id: str
    label: str
    court: str


class Pool(BaseModel):
    """A slice of tables reserved for a window of time within an event.

    Its ``id`` is the pool's **identity**: a fixture names the pool it was drawn into
    by that string (ADR-0786), and the pool-set freeze is a rule about the *set* of
    these ids. Which is only a coherent thing to say if an id names one pool — see
    ``EventPools``, the type the event's list of them actually has.
    """

    model_config = ConfigDict(extra="forbid")

    id: str
    name: str
    slot: Slot
    table_ids: list[str]


def named_list(names: list[str]) -> str:
    """The things a refusal is about, as a human would say them: ``“Pool B”``, or
    ``“Pool B” and “Pool C”``, or ``“Pool B”, “Pool C” and “Pool D”``.

    One formatter for every refusal that names a *set* of things — this module's 422s
    (a duplicated pool id) and ``app.tournaments``' 409s (the pool-set freeze's pools,
    the go-live precondition's events) alike — so a director cannot tell, from the
    punctuation, which layer refused them.

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


class TournamentFixtureRead(BaseModel):
    """One planned pairing of an event's draw (ADR-0786): a round and a position —
    plus a pool, when the draw is pooled — whose sides may still be unknown.

    A fixture is **not** a match. It materializes into one later (#788), and until it
    does ``match_id`` is ``null``.

    **Every ``null`` on this model is a fact, not a missing field**, and a client that
    dropped them would lose the draw's whole point:

    * ``entry_a_id`` / ``entry_b_id`` — ``null`` means **TBD**: the feeding fixture has
      not been decided yet, and ``advance()`` will fill this side in. It never means a
      bye — a bye is the *absence of a fixture row*, not a fixture with an empty side
      (ADR-0786), so there is no ``is_bye`` flag here to tell the two apart.
    * ``winner_entry_id`` — ``null`` while the fixture is undecided.
    * ``match_id`` — ``null`` until the fixture becomes a real match, which only happens
      once the tournament is ``live``.
    * ``pool_id`` — ``null`` means this fixture belongs to no pool: the draw is
      un-pooled (single-elim), or this is the KO stage of an rr-then-ko event. When
      set, it names a ``Pool`` in this same event's ``pools`` — a string ref into
      JSONB, not a foreign key, because pools are value-objects with no table.

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

    @computed_field  # type: ignore[prop-decorator]  # pydantic wraps the property
    @property
    def entered(self) -> int:
        """The registration count. Derived — there is no stored counter (ADR-0016).

        It is ``len(entrants)`` rather than a field of its own precisely so the
        count and the list it counts cannot disagree: an event that says it has
        52 entrants but lists 51 is not a representable state.
        """
        return len(self.entrants)


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
    address: Address
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
    address: Address | None = None
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

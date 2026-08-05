import uuid
from collections import Counter
from collections.abc import Mapping
from datetime import date, datetime, time
from decimal import ROUND_DOWN, Decimal
from typing import Annotated, Any, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    PrivateAttr,
    TypeAdapter,
    ValidationError,
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

# ----- the draw configuration, as a union tagged by the draw type -----------

MAX_QUALIFIERS_PER_POOL = 1000
"""The ceiling on **K** — the same 1000 the web client's event form enforces.

It is not the domain rule. K can never exceed the smallest pool's size in a real event,
and the cut already refuses that with a message naming both numbers
(``DegenerateDraw``). This is the *boundary* refusing counts that are nonsense on their
face and would otherwise reach the column: 1000 is far above any pool a table-tennis
event will ever have, and far below the ``Integer`` column's 2,147,483,647.

The number that matters is the one past the column, not the one past 1000. A K of
2,147,483,648 was a **500** — the driver refused it, deep behind the boundary, and the
client's generic error copy then told the organizer that nothing they did caused it,
which was false. A K of 999,999,999 was worse in the quieter way: ``201 Created``, and
an event whose draw can never be cut. Both are a 422 now, under the field, where the
organizer can see which number they meant."""

QualifiersPerPool = Annotated[int, Field(ge=1, le=MAX_QUALIFIERS_PER_POOL)]
"""**K** — how many of each pool's finishers advance into an ``rr-then-ko`` draw's
knockout stage.

``1 <= K <= MAX_QUALIFIERS_PER_POOL`` is the **static** half of the ADR's legal
configuration space ("rr-then-ko cuts both stages upfront and seeds qualifiers
rematch-free"): zero advances nobody, a negative count is not a count, and a count in
the billions is not a qualifier count at all, whatever the field looks like. It is
stated once, here, and shared by the create schema, the patch schema and the union arm
below, so the three cannot drift.

The two bounds that **move with the entrant count** — ``P × K >= 2`` and
``K <= ⌊N/P⌋`` — are deliberately *not* here. They are refused at the cut as
``DegenerateDraw``, because a configuration that was legal when it was written must not
become unwritable when a player withdraws (the same split ``_snake`` already uses for
its own pool floor)."""


class DrawSettingsWriteBase(BaseModel):
    """What every arm of the draw-settings union shares: ``extra="forbid"``, and the
    serialization onto the settings column.

    A base class rather than three copies, because the storage form is one rule (ADR "a
    draw type's settings are one NOT NULL JSON object") and a new arm that spelled it
    differently would store a shape the read side could not parse back.

    It adds **no field**, so it moves nothing on the wire and mints no OpenAPI
    component of its own.
    """

    model_config = ConfigDict(extra="forbid")

    def stored_settings(self) -> dict[str, Any]:
        """This arm as the object the settings column stores: its settings, **without**
        the discriminator.

        ``draw_type`` is excluded because it is not a setting — it is the column beside
        this one (``draw_type_key``, the FK onto ``draw_types``), and storing it twice
        would let the two disagree. The read side puts it back
        (``app.tournament_draw_settings.draw_settings_of``), which is what makes the
        round trip total.

        ``{}`` for the two draw types that take no configuration, and that is the whole
        representation of "no configuration" — never ``NULL``.
        """
        return self.model_dump(mode="json", exclude={"draw_type"})


class RoundRobinDrawSettingsWrite(DrawSettingsWriteBase):
    """A round-robin event's draw configuration: the draw type, and nothing else.

    ``extra="forbid"`` (inherited) is doing real work on this arm — it is what makes
    ``qualifiers_per_pool`` on a round-robin event a **422 at the boundary** rather than
    a value silently dropped on the way to storage. Since the settings column became one
    JSON object, this union is the **only** thing that says which settings belong to
    which draw type: the table's old ``CASE`` constraint went with the column it
    guarded. A director who names a qualifier count for a format that has no knockout
    stage has misunderstood something, and the useful answer is to say so, not to run
    the event they did not ask for.
    """

    draw_type: Literal[DrawType.round_robin] = DrawType.round_robin

    @property
    def qualifiers_per_pool(self) -> int | None:
        """``None`` — this draw type has no knockout stage to qualify for.

        A read-side **property**, not a field: the field's absence is what refuses the
        key on the wire, and this is what lets a caller holding the parsed union ask
        every arm the same question without an ``isinstance`` ladder."""
        return None


class SingleElimDrawSettingsWrite(DrawSettingsWriteBase):
    """A single-elimination event's draw configuration: the draw type, and nothing else.
    See :class:`RoundRobinDrawSettingsWrite` for why ``extra="forbid"`` is the rule and
    not decoration."""

    draw_type: Literal[DrawType.single_elim] = DrawType.single_elim

    @property
    def qualifiers_per_pool(self) -> int | None:
        """``None`` — a bracket has no pools to qualify out of."""
        return None


class RrThenKoDrawSettingsWrite(DrawSettingsWriteBase):
    """A round-robin-then-knockout event's draw configuration: the draw type **and** its
    qualifier count (ADR 20260727).

    ``qualifiers_per_pool`` is **required** here, with no default. There is no
    defensible number to assume — "2" is a convention, not a fact about the event — and
    a draw silently cut for a K the director never chose is the worst of the available
    failures: it looks like it worked."""

    draw_type: Literal[DrawType.rr_then_ko] = DrawType.rr_then_ko
    qualifiers_per_pool: QualifiersPerPool


DrawSettingsWriteArm = (
    RoundRobinDrawSettingsWrite
    | SingleElimDrawSettingsWrite
    | RrThenKoDrawSettingsWrite
)
"""The **arms** of the draw-settings union, listed once.

A parsed draw configuration is one of these — the type a caller holds after
:data:`DrawSettingsWrite` has done its work, and the type the parse itself returns. It
is named because the list of arms was being spelled three times (the discriminated
alias, its ``TypeAdapter``, and the parse's return type), which made "add a draw type"
three edits with nothing to catch a fourth spelling that fell behind. Now it is one, and
the three are the same list by construction rather than by review."""

DrawSettingsWrite = Annotated[DrawSettingsWriteArm, Field(discriminator="draw_type")]
"""An event's draw configuration as it arrives: a **discriminated union tagged by the
draw-type slug** (ADR 20260727, promised by ADR 20260726's companion and first built
here).

One arm per :class:`DrawType`, carrying exactly the configuration that draw type has —
which for two of the three is nothing at all. That is the whole point: "a round-robin
event with 2 qualifiers per pool" is not a payload this type can hold, so it cannot be
half-honoured. This union is now the **sole** enforcement of that pairing: the settings
table's ``CASE`` ``CHECK`` was dropped with the column it named (ADR "a draw type's
settings are one NOT NULL JSON object"), so nothing underneath catches a pair this type
lets through.

Adding a draw type is an arm in :data:`DrawSettingsWriteArm` above (one list, read by
this alias, its ``TypeAdapter`` and the parse alike), and it is *not* a type error until
it has one — the
enum's exhaustiveness is enforced at the four dispatch sites, and a missing arm surfaces
as ``_draw_settings_write`` refusing a payload the enum accepts. Which is loud, at the
boundary, and in the director's request."""

_DRAW_SETTINGS_WRITE: TypeAdapter[DrawSettingsWriteArm] = TypeAdapter(DrawSettingsWrite)


def _draw_settings_write(
    draw_type: DrawType, qualifiers_per_pool: int | None
) -> DrawSettingsWriteArm:
    """Parse a ``(draw_type, qualifiers_per_pool)`` pair into the union arm it names, or
    raise :class:`ValueError` — a 422 — when it names none.

    The pair is **flat on the wire** and a union in the interior. Nesting it
    (``draw: {…}``) would express the union in the generated clients too, at the cost of
    changing the shape of every event create and patch that has ever been written; the
    same rule is enforced either way, and this is the shape that lets the draw type stay
    where every existing caller already sends it.

    ``None`` means "no qualifier count was sent" and is therefore *omitted* rather than
    passed as ``null``: an absent key and an explicit ``null`` mean the same thing for
    this field — the draw type takes no count — and ``extra="forbid"`` would reject the
    explicit one on the two arms that have no such field.

    The refusal text is the **union's own**, re-raised as a ``ValueError`` so FastAPI
    renders it as an ordinary 422 body. Composing a friendlier sentence here would be a
    second statement of a rule the arms already make, and the two would drift.
    """
    payload: dict[str, object] = {"draw_type": draw_type}
    if qualifiers_per_pool is not None:
        payload["qualifiers_per_pool"] = qualifiers_per_pool
    try:
        return _DRAW_SETTINGS_WRITE.validate_python(payload)
    except ValidationError as exc:
        raise ValueError(
            f"“{draw_type.value}” draw settings: "
            + "; ".join(
                f"{'.'.join(str(part) for part in error['loc'])}: {error['msg']}"
                for error in exc.errors()
            )
        ) from exc


def draw_settings_from_storage(
    draw_type: DrawType, settings: Mapping[str, Any]
) -> DrawSettingsWriteArm:
    """Parse a stored ``(draw_type, settings)`` pair back into the union arm it is the
    serialized form of — the READ half of the settings column (ADR "a draw type's
    settings are one NOT NULL JSON object").

    The discriminator is not in the blob (``stored_settings`` leaves it out, because the
    row carries it in ``draw_type_key`` beside it), so it is put back here. It is put
    back as the **enum member**, never as the slug, because that is the shape
    :func:`_draw_settings_write` has always validated and the one place slug→enum
    happens is ``TournamentEventDrawSettings.draw_type``.

    Raises :class:`~pydantic.ValidationError` — deliberately NOT the ``ValueError`` its
    request-side sibling raises. That wrapper exists to render a **client's** bad pair
    as a 422; a stored blob that will not parse is nobody's request and must not be
    dressed up as one. It is a row that should not exist, and the loud failure is the
    point: the alternative is a settings object silently read as empty, which cuts a
    draw for a configuration nobody chose.
    """
    # ``draw_type`` goes LAST so the column wins. Splatting the blob last instead would
    # let a stored ``draw_type`` key override the discriminator this function was handed
    # — ``draw_type`` is a declared field on every arm, so ``extra="forbid"`` does not
    # catch it — and a row whose ``draw_type_key`` says ``round-robin`` would parse as
    # whatever arm its own JSON named. Nothing writes such a blob today
    # (``stored_settings()`` excludes the key), but "the union is the only enforcement"
    # is exactly the claim this change rests on, so it must hold against a writer that
    # did not go through it.
    return _DRAW_SETTINGS_WRITE.validate_python({**settings, "draw_type": draw_type})


# ----- value-objects (typed JSONB) -----------------------------------------

# ``ValueObjectId`` — the ``Annotated[str, Field(min_length=1)]`` a pool's id used to be
# — is gone, and its deletion is the point of the chore that minted them. It existed
# only because "pools and tables have no tables of their own, so a pool is addressed by
# a client-supplied string and nothing in the database constrains it" (ADR 20260726,
# which scoped its removal). Both halves of that are now false: a pool is a row, its id
# is a ``uuid`` the database mints, and the illegal state the floor was holding off —
# the empty-string id, which answered "is this fixture pooled?" and the draw-order tie-
# break inconsistently — is not expressible in a ``uuid`` at all. A type that cannot
# hold the bad value beats a validator that refuses it (api/CLAUDE.md, "make illegal
# states unrepresentable").


MAX_ADDRESS_COMPONENT = 255

AddressComponent = Annotated[str, Field(max_length=MAX_ADDRESS_COMPONENT)]
"""One free-text component of a venue address **as submitted** — bounded at 255.

The bound is stated once, here, and shared by all six components of
:class:`AddressInput`, for the same reason ``EventMaxPlayers`` is shared by the create
and the patch schemas: a value that cannot be created must not be reachable by editing.
255 is the conventional ceiling for a postal-address line; nothing shorter fits a real
venue name, and nothing longer is an address rather than an essay.

**This alias is deliberately absent from :class:`Address`, the stored/read shape**, and
that asymmetry is the whole point. A write boundary tightens: it may refuse input the
system has never accepted. A *read* boundary must stay permissive about history — rows
predating a bound still exist, and a ``max_length`` on the read model would turn each
one into a ``ValidationError`` at serialize time. One over-long row would then take out
every list and dashboard that reads it, converting a cosmetic data-quality issue into an
outage. So the bound goes on the way in only."""


class AddressInput(BaseModel):
    """The venue address a client **sends** on a write (create/edit).

    Six free-text components and **no coordinates**: coordinates are geocoded
    server-side at write time and are never supplied by a client (ADR "a venue's
    coordinates are geocoded server-side at write time and are NOT NULL"). A client
    that tries to send ``latitude``/``longitude`` gets a 422 — ``extra="forbid"`` —
    rather than an unverified number the server would have to trust or re-check.

    Each component is bounded at :data:`MAX_ADDRESS_COMPONENT` characters
    (:data:`AddressComponent`); the stored :class:`Address` is deliberately unbounded,
    for the reason given there.

    The write verbs geocode this input and construct the stored :class:`Address`
    (with coordinates) before persisting; this is the shape on the *request*
    schemas, and :class:`Address` is the shape on the *read* schemas.

    An instance of this model whose six components are **all blank** is not a venue —
    the write schemas normalize it to ``None`` at the boundary
    (:data:`SubmittedAddress`), so it never reaches the geocoder or the column."""

    model_config = ConfigDict(extra="forbid")

    venue: AddressComponent
    street: AddressComponent
    city: AddressComponent
    region: AddressComponent
    postal: AddressComponent
    country: AddressComponent


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
    has no coordinates.

    The six components here are plain ``str`` — **unbounded on purpose**, unlike the
    255-character :data:`AddressComponent` the write shape uses. This model's job is to
    make stored history readable, not to re-litigate it: a length bound here would make
    a single over-long row unserializable and take down every page that reads it. See
    :data:`AddressComponent`.

    A tournament may have **no** address at all (``Address | None`` on the reads) — an
    announced-but-unbooked or deliberately-withheld venue is a first-class state
    (CONTEXT.md, "Venue"). What this model rules out is the *half*-populated address:
    when there is a venue, its coordinates are known."""

    model_config = ConfigDict(extra="forbid")

    venue: str
    street: str
    city: str
    region: str
    postal: str
    country: str
    latitude: float
    longitude: float


def _blank_address_is_no_venue(value: AddressInput | None) -> AddressInput | None:
    """Normalize an all-blank submitted address to ``None`` — "this tournament has no
    venue" — before anything downstream sees it.

    A tournament with no venue is a real state (CONTEXT.md, "Venue"), and SQL ``NULL``
    is its **one** representation. Six empty strings would be a second one: a stored
    object that is an address in shape and nothing in content, which every reader would
    have to test for. So it is collapsed here, at the boundary, rather than defended
    against downstream (parse-at-boundaries).

    Without this, "no venue" would be unreachable from the web form, which submits six
    controlled text inputs and has no gesture meaning "omit the ``address`` key" — the
    browser organizer who has not booked a venue yet would be refused. And it must run
    **before** the geocoder: a blank address resolves to zero candidates, which is a
    coded 409 ("we couldn't locate that address"), so an organizer leaving the venue
    empty would otherwise be told their nonexistent venue could not be found.

    Whitespace counts as blank — a stray space typed into one of six boxes is not a
    venue, and treating it as one would make the difference between "no venue" and "a
    venue named ``' '``" depend on an invisible character.
    """
    if value is None:
        return None
    components = (
        value.venue,
        value.street,
        value.city,
        value.region,
        value.postal,
        value.country,
    )
    if not any(component.strip() for component in components):
        return None
    return value


SubmittedAddress = Annotated[
    AddressInput | None, AfterValidator(_blank_address_is_no_venue)
]
"""The venue address on a **write** payload: an :class:`AddressInput`, or ``None`` for
"no venue" — with an all-blank input normalized to ``None``
(:func:`_blank_address_is_no_venue`).

Shared by :class:`TournamentCreate` and :class:`TournamentUpdate` so the two verbs
cannot disagree about what an empty venue box means."""


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


class TournamentTableWrite(BaseModel):
    """A physical table in the venue catalogue, as a client **sends** it: what the
    table is called and where it stands. Nothing else — in particular, not an ``id``.

    A table is a row now (ADR 20260801, "a placement names a real table"), and its id
    is minted by the database (``gen_random_uuid()``). So the id is simply not a field
    of this model, and ``extra="forbid"`` turns an attempt to send one into a 422 that
    names it — the treatment :class:`PoolWrite` gives ``position`` and the event
    schemas give ``entered``. A server-managed value is kept **off** the write shape
    rather than accepted and then ignored: a client cannot tell from the schema that the
    id it sent decided nothing, and a boundary that silently discards half of a payload
    has to be documented to be understood.

    That is a real change of who owns a table's identity, and it is the point of the
    ADR. While the catalogue was JSONB, the id was a client-supplied string with nothing
    to key on, which is the only reason a placement naming no table could be *stored*
    rather than refused. The **order** of the list is what a client does control: it is
    the catalogue's order, and the server assigns each table its place from it.

    This is the shape a **create** takes, and there it is the whole story: a tournament
    being born has no tables, so there is nothing an ``id`` could name. A *patch* is a
    diff over tables that already exist, so its entries derive from this one and add an
    optional ``id`` naming the table they keep (:class:`TournamentTableUpsert`) — which
    is citing an id, not authoring one, and does not disturb who mints them.
    """

    model_config = ConfigDict(extra="forbid")

    label: str
    court: str


class TournamentTableUpsert(TournamentTableWrite):
    """One entry of a catalogue a client **edits** (``PATCH /v1/tournaments/{id}``):
    everything :class:`TournamentTableWrite` carries, plus an **optional** ``id`` naming
    a table the tournament already has.

    The optional id is what makes the catalogue write a **diff** rather than a
    positional overwrite, and it exists because the ADR's removal semantics need one.
    The two cases are exhaustive and mean different things:

    * ``id`` **present** — "this is the table you already have, with these words". The
      row keeps its id (and therefore every pool ``table_ids`` entry and every fixture
      ``table_id`` that names it) and takes the new ``label``/``court``, and its place
      in the list is its new place in the catalogue's order.
    * ``id`` **omitted** (or ``null``) — "add a table". The server mints its id, exactly
      as on create.
    * a stored table **no entry names** — "remove it". Which is the whole reason this
      field had to arrive: a removal can be *refused*
      (:class:`~app.tournament_errors.TableInUseError`), and a verb that cannot tell
      "the table you renamed" from "a different table at the same index" cannot tell a
      rename from a removal either.

    That last point is why the by-position stopgap this replaces could not stand.
    Matching the i-th sent against the i-th stored made **reordering swap labels between
    ids**: send the same two tables in the other order and each row kept its id and took
    its neighbour's words, so a fixture placed at "Table 1" started rendering as
    "Table 2". Nothing refused it and nothing could see it — an id is not a position,
    and only the client knows which of its rows is which.

    An id that names no table of *this* tournament is a 422 on the field, not a silently
    minted new table: a client that names a table it cannot see has a bug, and quietly
    handing it a different id than it asked for would hide it (parse-at-boundaries).

    It is deliberately **not** on :class:`TournamentTableWrite`, the create shape: a
    tournament being born has no tables to name, so an ``id`` there is still a 422 for
    an unknown field. Nothing about who mints an id has changed — the server still does
    (ADR 20260801); what changed is that a client may now *cite* one it was given.
    """

    model_config = ConfigDict(extra="forbid")

    id: uuid.UUID | None = None


class TournamentTable(TournamentTableWrite):
    """A table in the venue catalogue as it is **read back**: everything a client wrote,
    plus the ``id`` the server minted for it.

    Deriving it from :class:`TournamentTableWrite` keeps the two shapes one shape plus
    a field, exactly as :class:`Pool` derives from :class:`PoolWrite`: a column added to
    the write side is readable without a second edit, and the two can never disagree
    about what a table *is*.

    ``id`` is a UUID — the ``tournament_tables`` row's primary key. It is what a pool's
    ``table_ids`` and a fixture's ``table_id`` name, and (from the fixture side) what a
    foreign key will hold.
    """

    model_config = ConfigDict(extra="forbid", from_attributes=True)

    id: uuid.UUID


PoolPosition = Annotated[
    int,
    Field(
        ge=0,
        description=(
            "Where this pool sits in its event's pool order: 0-based, contiguous, and "
            "**assigned by the server** from the pool's index in the `pools` list it "
            "arrived in. Read-only, and not merely by convention — it is absent from "
            "the pool shape the write verbs take, so sending one is a `422` for an "
            "unknown field. To reorder an event's pools, send them in the order you "
            "want. Two pools of one event never share a position."
        ),
    ),
]
"""A pool's place in its event's pool order — 0-based, server-assigned, read-only.

Pool order is a **fact about the event**, and until this field existed it was carried by
two things that have now both gone (ADR 20260801, "Pools carry an explicit
``position``"): the JSONB array's order, which ended when pools became rows, and the
lexicographic sort of the client-minted ``p-1-…``/``p-2-…`` ids, which ends when those
ids become uuids. Under a random uuid primary key, sorting by id is *arbitrary* — pools
would render in a random order and the snake would seed against a random order,
producing a draw that still cuts but seeds differently. Invisible to the type checker;
findable only by QA. An explicit ordering column is the only thing that survives the id
change, which is why it was written first, while the array order was still there to
derive it from.

It lives on :class:`Pool`, the shape a client **reads**, and deliberately not on
:class:`PoolWrite`, the shape it **sends**. The server stamps it in
``app.tournament_pools`` — the one seam between the two — from the pool's index in the
list it was sent, so an event's positions are ``range(len(pools))`` by construction.
That is what makes "two pools of one event share a position" unrepresentable through the
API, and it is why "server-assigned" is a property of the schema here rather than a
claim in prose: the field a client cannot send is a field it cannot decide."""


def _slot_is_storable(slot: Slot) -> Slot:
    """Refuse a pool window whose strings are not the ``YYYY-MM-DD`` / ``HH:MM`` this
    shape has always claimed to be (422).

    A pool's window is three real columns now — ``slot_date DATE``, ``slot_start TIME``,
    ``slot_end TIME`` (ADR 20260801) — where it used to be three strings inside a JSONB
    blob that accepted literally anything. ``"next Tuesday"`` was a storable pool window
    until this line existed; past it, it is a driver error at the INSERT, i.e. a 500 for
    a payload the boundary waved through. A boundary that admits what the interior
    cannot hold is not a boundary (:data:`EventMaxPlayers` is the same lesson in a
    different key).

    Seconds are refused rather than truncated. The stored value must compose back into
    the ``HH:MM`` the wire shape promises, and a window silently read back one minute
    from where the director set it is worse than a refusal that says what to send.

    An ``AfterValidator`` on the *pool's* slot only, not on :class:`Slot` itself: the
    event's own ``slot`` is still an untyped JSONB value-object with no columns behind
    it, and tightening it here would be a rule about a field this chore does not move.
    It contributes nothing to the JSON schema, so the OpenAPI shape of a pool's ``slot``
    is the ``Slot`` it always was.
    """
    try:
        date.fromisoformat(slot.date)
        start = time.fromisoformat(slot.start)
        end = time.fromisoformat(slot.end)
    except ValueError as exc:
        raise ValueError(
            "A pool's window is a date and two times: “date” must be YYYY-MM-DD and "
            f"“start”/“end” must be HH:MM ({exc})."
        ) from exc
    if any(t.second or t.microsecond for t in (start, end)):
        raise ValueError(
            "A pool's window is stated to the minute: “start” and “end” must be HH:MM, "
            "with no seconds."
        )
    return slot


PoolSlot = Annotated[Slot, AfterValidator(_slot_is_storable)]
"""A pool's window — a :class:`Slot` that the pool's own ``date``/``time`` columns can
actually hold. See :func:`_slot_is_storable`."""


class PoolWrite(BaseModel):
    """A slice of tables reserved for a window of time within an event, as a client
    **creates** it.

    It has **no** ``id``, and that absence is the whole content of the chore that minted
    them: a pool's id is a uuid the database mints (ADR 20260801's ``id uuid PRIMARY
    KEY``), so it is not the client's to author and there is nothing here for it to
    author. Sending one is a 422 for an unknown field — the same treatment
    :class:`TournamentTableWrite` gives a venue table's id, and for the same reason. A
    client that *cites* an id it was given is patching, not creating, and the shape for
    that is :class:`PoolUpsert`.

    Its ``name`` has a floor for the plainer reason: a pool is *called* something — it
    is what the director clicks, what the conflict warnings quote, and what a player
    reads off a wall. ``""`` is not a name, and an event whose pools list is three blank
    rows is not a thing anyone could act on.

    ``position`` is absent for the same reason the id is: it is the server's to assign
    (:data:`PoolPosition`), so it is simply not a field of this model, and
    ``extra="forbid"`` turns an attempt to send one into a 422 that names it. This is
    the treatment ``entered`` already gets on the event schemas — a server-managed value
    is kept **off** the write shape rather than accepted and then ignored. Accepting it
    would be worse than useless in both directions: a client cannot tell from the schema
    that the number it sent decided nothing, and a boundary that silently discards half
    of a payload has to be documented to be understood. The order a client *does*
    control is the order of the list itself.
    """

    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1)
    slot: PoolSlot
    table_ids: list[str]


class PoolUpsert(PoolWrite):
    """One pool of an event a client **edits** (``PATCH …/events/{id}``): everything
    :class:`PoolWrite` carries, plus an **optional** ``id`` naming a pool the event
    already has.

    The exact twin of :class:`TournamentTableUpsert`, one resource over, and the two
    cases are exhaustive:

    * ``id`` **present** — "this is the pool you already have, with these words". The
      row keeps its id, and therefore every fixture drawn into it and every table it
      reserves, and takes the new ``name``/``slot``/``table_ids``; its place in the list
      is its new place in the event's pool order.
    * ``id`` **omitted** (or ``null``) — "add a pool". The server mints its id, exactly
      as on create.
    * a stored pool **no entry names** — "remove it".

    ``X | None = None`` and never a non-null default: an optional field on a *write*
    schema whose default is not ``None`` generates as **required** in the TypeScript
    client, which would make "omit the id to add a pool" unsayable there.

    An id that names no pool of *this* event is a 422 on the field
    (:class:`~app.tournament_errors.PoolNotInEventError`), not a quietly minted new
    pool. Until this chore that arm was an *addition*, because the id was the client's
    and an id the server had never seen still named the pool the client meant. It is the
    server's now, so an id it did not mint names nothing — and minting a fresh one would
    hand the client back a different id than it asked for while *removing* the pool it
    meant to keep, which is the pair of failures a diff must never confuse."""

    model_config = ConfigDict(extra="forbid")

    id: uuid.UUID | None = None


class Pool(PoolWrite):
    """A pool as it is **read back**: everything a client wrote, plus the ``id`` the
    server minted for it and the ``position`` it stamped on it.

    It is also the model every interior read of an event's pools arrives through —
    ``_ordered_pools``, ``draw_config``, ``event_pools``, the schedule snapshots — which
    is why moving pools from a JSONB array into ``tournament_event_pools`` rows changed
    nothing above ``app.tournament_pools.pool_read``: the projection composes this same
    model out of typed columns where it used to validate it out of untyped dicts.
    Deriving it from :class:`PoolWrite` is what keeps the two shapes one shape plus two
    fields, exactly as :class:`TournamentTable` derives from
    :class:`TournamentTableWrite`: a column added to the write side is readable without
    a second edit, and the two can never disagree about what a pool *is*.

    ``position`` keeps its ``0`` default even though the column is NOT NULL and every
    row carries a real one: the default is what lets a **literal** ``Pool`` be built in
    a test or a REPL without spelling an order out, and a read boundary that
    hard-required it would gain nothing — the projection always supplies it. ``id`` has
    no default, because there is no id a literal pool could sensibly default to."""

    id: uuid.UUID
    position: PoolPosition = 0


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


def _pool_ids_are_unique(pools: list[PoolUpsert]) -> list[PoolUpsert]:
    """Refuse an edited pool list when two of its entries cite the same pool ``id``
    (422).

    A pool id is an **identity**, and everything downstream is built on the assumption
    that it identifies one pool. Nothing enforced it: pools were JSONB with
    client-supplied string ids, there was no pools table and so no unique index, and
    ``[A, A]`` was stored verbatim (measured: **201**). The bill arrived at
    the cut, which deals the field across the event's pool ids and writes a fixture per
    pairing — two pools with one id deal onto the same ``(event_id, pool_id, round,
    position)``, the fixture table's unique constraint fires, and the director gets a
    **500** from the driver
    (``uq_tournament_fixtures_event_id_pool_id_round_position``, reproduced before this
    validator existed). A boundary that admits what the interior cannot hold is not a
    boundary.

    Pools are rows with a uuid primary key now (ADR 20260801), so a duplicate is also a
    thing the database would refuse — but this validator is still the enforcement worth
    having, and not only because a 422 naming the ids beats an ``IntegrityError``: the
    write is an id-keyed diff (``app.tournament_pools``), and ``[A, A]`` would resolve
    *both* entries onto the one stored row, so the payload would be accepted as a
    single-pool event rather than refused as the two-pool one it claims to be.

    **Entries with no ``id`` are ignored**: those are additions, and any number of new
    pools may be added at once — exactly as :func:`_table_ids_are_unique` treats them.

    It is a rule about the **list**, so it is a validator on the list type
    (:data:`EditedEventPools`) rather than on an entry — an entry cannot see its
    siblings. It has no create-path twin any more, and does not need one: the create
    shape (:class:`PoolWrite`) has no ``id`` at all, so "the patch path is the hole" —
    the bug that made this a shared rule when both verbs took ids — is not a hole a
    ``create`` can have. This *is* the patch path, and it was always the worse of the
    two: the pool-set freeze that protects a cut draw compares **sets**, so ``[A, A,
    B]`` against a cut event holding ``{A, B}`` is the same set, the freeze waved it
    through (measured: **200**) and the next cut died.

    The duplicated **ids** are named, not the pools' names: an id is what is duplicated,
    two pools sharing one id may well have different names, and the id is what the
    director must edit. The refusal is a 422 rather than a 409 because this is a
    malformed payload in any state the event could possibly be in — an event with no
    draw at all still cannot cite one pool twice.
    """
    counted = Counter(pool.id for pool in pools if pool.id is not None)
    duplicated = [str(pool_id) for pool_id, count in counted.items() if count > 1]
    if duplicated:
        raise ValueError(
            f"A pool id identifies one pool: {named_list(duplicated)} "
            f"{'is' if len(duplicated) == 1 else 'are'} cited by more than one entry "
            "of this event's pools. Cite each pool you are keeping exactly once, and "
            "omit the id of a pool you are adding."
        )
    return pools


EventPools = list[PoolWrite]
"""An event's pools **as a client creates them** (``POST …/events``): any number of
them, none carrying an ``id`` or a ``position`` (:class:`PoolWrite`).

A bare list with no validator, where the patch shape has one: an event being born has no
pools to cite, so there are no ids in this payload for two entries to share. The
asymmetry is the same one :class:`TournamentTableWrite` and :data:`EditedTableCatalogue`
already have, and it comes from the same fact — the server mints the ids.

The list's **order** is the payload's one statement about pool order:
``app.tournament_pools`` turns it into the stored positions."""


EditedEventPools = Annotated[list[PoolUpsert], AfterValidator(_pool_ids_are_unique)]
"""An event's pools **as a PATCH sends them**: the pool list in full and in order, each
entry either citing the pool it keeps or omitting an ``id`` to add one
(:class:`PoolUpsert`), and no two entries citing the same pool.

It is the **whole** list every time, not a list of changes: what a client sends is the
state it wants, and the verb computes the remove/keep/add from it
(:func:`~app.tournament_pools.apply_event_pools`). That is what makes "a pool this
payload does not mention is removed" a statement about the payload rather than about the
order things happened to be in — and it is what the pool-set freeze judges, before
anything is written, when the event's draw is already cut.

Re-ordering the entries re-orders the event's pools, on this verb alone: the create verb
has only one order to state, and this one can restate it.

An ``AfterValidator``, deliberately: it runs on the parsed entries (so it reads
``pool.id``, not ``pool["id"]``) and it contributes **nothing** to the JSON schema, so
the OpenAPI shape of ``pools`` is the array it always was — the same arrangement
:data:`EditedTableCatalogue` uses for the same reason."""


def _table_ids_are_unique(
    tables: list[TournamentTableUpsert],
) -> list[TournamentTableUpsert]:
    """Refuse an edited catalogue when two of its entries cite the same table ``id``
    (422) — the diff's twin of :func:`_pool_ids_are_unique`.

    ``[{id: X, label: "Table 1"}, {id: X, label: "Table 2"}]`` is not a catalogue: it
    asks one row to be in two places at once and to be called two things. The diff would
    have to pick a winner, and either pick is a catalogue the director did not send —
    the row lands at one of the two positions with one of the two labels, and the
    "other" table it looked like they were keeping is silently *removed* instead, taking
    its fixtures' placements through the 409 (or, with the opt-in, through an unplacing
    the director never asked for).
    A rule about the **list**, so it is a validator on the list type
    (:data:`EditedTableCatalogue`) rather than on an entry — an entry cannot see its
    siblings. Entries with no ``id`` are ignored: those are additions, and any number of
    new tables may be added at once.

    The duplicated **ids** are named rather than the labels, exactly as the pool rule
    names ids: the id is what is duplicated, two entries citing one id may well carry
    different labels, and the id is what the client has to fix. A 422, not a 409,
    because it is a malformed payload whatever state the tournament is in.
    """
    counted = Counter(table.id for table in tables if table.id is not None)
    duplicated = [str(table_id) for table_id, count in counted.items() if count > 1]
    if duplicated:
        raise ValueError(
            f"A table id names one table: {named_list(duplicated)} "
            f"{'is' if len(duplicated) == 1 else 'are'} cited by more than one "
            "entry of this catalogue. Cite each table you are keeping exactly once, "
            "and omit the id of a table you are adding."
        )
    return tables


EditedTableCatalogue = Annotated[
    list[TournamentTableUpsert], AfterValidator(_table_ids_are_unique)
]
"""A venue catalogue **as a PATCH sends it**: the catalogue in full and in order, each
entry either citing the table it keeps or omitting an ``id`` to add one
(:class:`TournamentTableUpsert`), and no two entries citing the same table.

It is the **whole** catalogue every time, not a list of changes: what a client sends is
the state it wants, and the verb computes the delete/keep/add from it
(:func:`~app.tournament_tables.apply_table_catalogue`). That is what makes "a table this
payload does not mention is removed" a statement about the payload rather than about the
order things happened to be in.

An ``AfterValidator`` on the list, deliberately: it runs on the parsed entries (so it
reads ``table.id``, not ``table["id"]``) and contributes **nothing** to the JSON schema,
so the OpenAPI shape of ``table_catalogue`` stays the array it always was — the same
arrangement :data:`EventPools` uses for the same reason."""


# The composition of the pools an event stores lives in ``app.tournament_pools`` now,
# not here. It used to be ``stored_pools``, a list of JSONB dicts, because the column
# was JSONB; a pool is a row (ADR 20260801), so what a write verb composes is
# ``TournamentEventPool`` rows — a model, which a schema module must not import.


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
      un-pooled (single-elim), or this is the KO stage of an rr-then-ko event. When
      set, it names a pool of **this same event**, and it is guaranteed to: the column
      is half of a composite foreign key onto ``tournament_event_pools (event_id, id)``,
      so it is neither a dangling ref nor another event's pool (ADR 20260801).
    * ``table_id`` — the fixture's **placement** table (ADR-0790): ``null`` means
      **unassigned to a table**. When set, it names a ``TournamentTable`` in the
      tournament's ``table_catalogue``, and it is guaranteed to: the column is a real
      foreign key, so this is never a dangling ref (ADR 20260801). Carried as the id's
      text, the same form a pool's ``table_ids`` carry.
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
    pool_id: uuid.UUID | None
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
    # A placement. ``table_id`` is a table of the tournament's catalogue, by id and by
    # foreign key (never dangling, ADR 20260801); both it
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

    ``pool_id`` names a pool of this same event — the id a fixture also carries — so a
    client titles the table from the pool it already holds."""

    pool_id: uuid.UUID
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
    knockout stage to join its pool winners, so it is ``null`` there even when
    ``complete``; and ``null`` while any fixture is still to be played. An event that
    *does* have a knockout stage to join them is a ``rr-then-ko`` draw, which reads out
    as the ``standings_then_finishes`` arm below and is crowned from its bracket — a
    different shape, not an exception to this one."""

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


class StandingsThenFinishesResultsRead(BaseModel):
    """The **two-stage** shape of an event's results (ADR 20260727) — the
    round-robin-then-knockout arm of the ``results`` discriminated union, tagged
    ``kind: "standings_then_finishes"``.

    One block per stage: ``pools`` is the pool stage's standings, exactly the
    :class:`PoolStandingsRead` a round-robin event reads out, and ``finishes`` is the
    knockout stage's ranked :class:`FinishRowRead`\\ s, exactly the ones a
    single-elimination event reads out. They are the *same* models rather than
    two-stage-flavoured near-copies, so a client renders each stage with the panel it
    already has and the two shapes cannot drift apart.

    A third arm rather than a restructuring of the union into a composite: making
    ``standings`` and ``finishes`` sub-objects of one wrapper would change how the
    existing two arms are read, forcing round-robin and single-elim client changes that
    buy nothing.

    ``champion`` is the **knockout final's winner, never a pool leader** — the pool
    stage only seeds the bracket, so topping a pool wins nothing — and ``null`` until
    that final is decided. ``complete`` is **both stages decided**. Live and partial
    like every other results shape: the pool tables fill in as pool matches land, and
    the finishes list grows as the bracket is played out."""

    kind: Literal["standings_then_finishes"] = "standings_then_finishes"
    pools: list[PoolStandingsRead]
    finishes: list[FinishRowRead]
    complete: bool
    champion: uuid.UUID | None


# An event's results cross the wire as a **discriminated union tagged by shape**
# (ADR-0785): a round-robin reads out ``standings``, a single-elim reads out
# ``finishes``, and a round-robin-then-knockout reads out ``standings_then_finishes`` —
# both blocks at once (ADR 20260727). Coercing finishes into the standings row shape was
# rejected — a bracket has no wins/game-difference columns, so every such row would
# carry meaningless nullable fields, the tri-state smell ``api/CLAUDE.md`` warns
# against. Each shape is its own model; the client switches on ``kind``.
EventResultsRead = Annotated[
    StandingsResultsRead | FinishesResultsRead | StandingsThenFinishesResultsRead,
    Field(discriminator="kind"),
]


class TournamentEventRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    tournament_id: uuid.UUID
    name: str
    format: EventFormat
    draw_type: DrawType
    # **K** — how many of each pool's finishers advance into the knockout stage — read
    # back flat beside the ``draw_type`` it belongs to, exactly as the write schemas
    # send the pair (ADR 20260727). Both halves come off the same ``draw_settings`` row,
    # so this is the stored configuration and not a second copy of it.
    #
    # ``null`` for a round-robin or single-elim event, and that is a *fact* rather than
    # missing data: neither draw type has a qualifier count, which is what the write
    # union says at the boundary. (It is no longer also said in DDL — the settings
    # table's ``CASE`` ``CHECK`` was dropped with the column it named.) This read is the
    # second statement of the same pairing and it cannot disagree with the union,
    # because it does not decide anything — it reports the parsed arm.
    #
    # It is on the read at all because the client edits the pair as a unit. The event
    # editor always sends ``draw_type``, and the server parses ``(draw_type, K)``
    # together with K required and no default — so every PATCH of an rr-then-ko event,
    # even a rename, has to carry a K. Without this field the client would have to guess
    # one, which pre-draw silently overwrites the director's number and post-draw trips
    # the freeze with a 409 for an edit nobody made.
    qualifiers_per_pool: int | None
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
    # for a single-elimination bracket, ``kind: "standings_then_finishes"`` (both, one
    # block per stage, ADR 20260727) for a round-robin-then-knockout event. Each fills
    # in as results land and crowns a champion when the last one does. ``null`` only for
    # an event with no draw cut — nothing to stand; every draw type has a results
    # strategy, because the enum holds only what runs. It rides on this same payload for
    # the same one-endpoint-per-page reason ``fixtures`` does: results are part of the
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
    # ``null`` means **this tournament has no venue** — a first-class state, not
    # missing data (CONTEXT.md, "Venue"; the ADR's 2026-07-26 amendment). It covers
    # both the not-booked-yet and the deliberately-withheld cases, which nothing
    # downstream needs to tell apart: such a tournament simply never matches a
    # proximity search. When an address IS present its coordinates are always known.
    address: Address | None
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
    #
    # **Optional**: omitted — or sent all-blank, which ``SubmittedAddress`` normalizes
    # to ``None`` — creates a tournament with no venue. Organizers announce before the
    # venue is booked, and a private tournament may withhold its address deliberately;
    # requiring one here made both impossible through every write path (#1206).
    address: SubmittedAddress = None
    # The venue catalogue, in the order it should be shown. Each entry is a label and a
    # court and nothing else — a table's id is minted by the server (ADR 20260801), so
    # sending one is a 422 (``TournamentTableWrite``, ``extra="forbid"``).
    table_catalogue: list[TournamentTableWrite] = Field(default_factory=list)
    league_id: uuid.UUID | None = None


class TournamentUpdate(BaseModel):
    """Partial update. A field that is *absent* is left unchanged; an explicit
    value replaces the current one. ``name`` maps to a NOT NULL column and
    ``table_catalogue`` to a whole child table, so for those an explicit ``null`` is
    rejected (422) rather than allowed to reach the DB — "omitted" and "cleared"
    are different. ``description``/``start_date``/``end_date`` are nullable
    columns and may be cleared.

    ``table_catalogue``, when present, is the catalogue **in full and in order**, and it
    is applied as an **id-keyed diff** (ADR 20260801): an entry that cites an ``id``
    keeps that table (with the words and the place this payload gives it), an entry with
    no ``id`` adds one, and a stored table no entry cites is **removed**. Citing the id
    is what makes a reorder move *tables* rather than swap labels between ids, and it is
    what lets a removal be refused — see ``unplace_fixtures_on_removed_tables``.

    ``address`` is nullable too, as of #1206: **omitted means unchanged; ``null`` — or
    an all-blank object, which :data:`SubmittedAddress` normalizes to ``null`` — means
    remove the venue.** It used to be in the rejected-``null`` set on the stated grounds
    that it "maps to a NOT NULL column"; that is simply no longer true of
    ``tournaments.address``, and keeping the rejection would have enforced a constraint
    the database does not have — leaving an organizer no way to un-book a venue.

    ``status`` is **not** updatable and is absent here on purpose: the lifecycle
    runs forward only across guarded edges, so the one way it moves is
    ``POST /v1/tournaments/{id}/transitions`` (ADR-0017). A guard on that route
    that left a ``status`` field on this one would have guarded nothing, so
    sending ``status`` here is a 422 via ``extra="forbid"``.

    ``unplace_fixtures_on_removed_tables`` is the **removal opt-in**, not a field of the
    tournament: it decides what happens when this payload's ``table_catalogue`` drops a
    table that matches are placed at. **Omitted** — or ``false``, or ``null`` — the
    whole edit is refused with a ``409`` naming the table, and nothing is written. Set
    ``true``, the removal goes through and those matches are unplaced — table, predicted
    start and pin all cleared — which is why it is said on purpose (ADR 20260801). A
    table that only a *pool* reserves needs no opt-in: the pool reserves one fewer.

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
    # ``TournamentCreate.address``). An omitted key leaves the stored address (and its
    # coordinates) unchanged; an explicit ``null`` (or an all-blank object) removes the
    # venue. Note that this makes ``address is None`` ambiguous between "absent" and
    # "remove" — the disambiguator is ``"address" in updates.model_fields_set``, never
    # the value.
    address: SubmittedAddress = None
    # The venue catalogue in full, in the order it should be shown, or omitted to leave
    # it alone. An entry citing an ``id`` is a table this tournament already has; an
    # entry with no ``id`` is a new one; a stored table no entry cites is removed. Send
    # back the catalogue you read, edited — the ids came from the read.
    table_catalogue: EditedTableCatalogue | None = None
    league_id: uuid.UUID | None = None
    # The removal opt-in, and the one field on this model that is not a value the
    # tournament ends up holding: it is a **confirmation**, and it is inert unless this
    # payload's ``table_catalogue`` removes a table that matches are placed at. A
    # removal is refused (409) by default precisely so this cannot happen by accident —
    # silently unplacing a match as a side effect of editing the venue would make it
    # indistinguishable from a match nobody ever placed (ADR 20260801).
    #
    # It rides on the body rather than on a query string so the MCP ``edit_tournament``
    # tool — which takes this very model and has no query string — offers the director's
    # agent the same way out the HTTP caller has, out of one schema that cannot drift.
    #
    # ``bool | None``, defaulting to ``None`` rather than ``bool = False``, because on a
    # PATCH an omitted key must stay omittable — and **the discriminator generated
    # clients use is the default's nullness, not the field's optionality**. A non-null
    # default (``False``) is emitted into the JSON schema as ``"default": false``, and
    # ``openapi-typescript`` promotes any property carrying one to **required**: a PATCH
    # that renames a tournament — ``{"name": "…"}``, or even ``{}`` — stopped
    # type-checking, because an opt-in for one destructive action had become mandatory
    # on every unrelated write. That is wrong for a partial update, where omitting a key
    # means "unchanged" and this key means "and I am not removing anything". A ``None``
    # default emits no ``default`` at all and generates as ``field?: boolean | null``,
    # which is the same trap ``position`` sprang on the pool write shape.
    #
    # The three-valued *wire* type does NOT reach the interior: ``None`` and ``False``
    # are the same answer (nobody opted in) and :attr:`unplacing_is_confirmed` collapses
    # them into the one ``bool`` the verb takes, so nothing downstream can ask this
    # question and get three answers (api/CLAUDE.md, "no tri-state booleans").
    unplace_fixtures_on_removed_tables: bool | None = None

    @property
    def unplacing_is_confirmed(self) -> bool:
        """Did this payload opt in to removing a table matches are placed at?

        The **one** reading of :attr:`unplace_fixtures_on_removed_tables`, and the
        reason that field's three wire values are only ever two states inside: an opt-in
        is something a caller *says*, so anything that is not ``true`` — ``false``,
        ``null``, or an absent key — is a caller who did not say it, and the removal is
        refused (:class:`~app.tournament_errors.TableInUseError`).

        A read-side ``property`` rather than a validator that coerces the field, for the
        reason :meth:`RoundRobinDrawSettingsWrite.qualifiers_per_pool` is one: the
        field's declared type is what shapes the wire (and here, what keeps the key
        omittable), while this is what the interior holds. Callers take this and never
        the field, so ``unplace_fixtures`` stays a total ``bool``.
        """
        return self.unplace_fixtures_on_removed_tables is True

    @field_validator("name", "table_catalogue", "league_id", mode="before")
    @classmethod
    def _reject_explicit_null(cls, value: Any) -> Any:
        # These map to NOT NULL columns. ``mode="before"`` runs even when the
        # client sends an explicit ``null``; omitting the key entirely skips
        # the validator and keeps the default (the "absent" case).
        #
        # ``address`` is deliberately NOT in this list: its column is nullable
        # (#1206), so ``null`` there is a legitimate "remove the venue", not a
        # constraint violation dressed up as a 422.
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
    # **K**, and only for the one draw type that has one. It is flat beside
    # ``draw_type`` on the wire and a *union* in the interior: the pair is parsed into
    # ``DrawSettingsWrite`` by the validator below, so a qualifier count on a
    # round-robin or single-elim event is a 422 here and never a value quietly dropped
    # (ADR 20260727). ``QualifiersPerPool`` is the same ``1 <= K <= 1000`` alias the
    # union arm carries, restated on the field so both bounds reach the generated
    # clients too.
    qualifiers_per_pool: QualifiersPerPool | None = None
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
    # ``EventPools`` — the CREATE shape (``PoolWrite``), which carries neither an ``id``
    # nor a ``position``: both are the server's to assign, so an editor that echoes one
    # back gets a 422 naming the field rather than a value that quietly decided nothing.
    # The list's ORDER is what the server reads the pool order off (``stored_pools``).
    # The patch schema takes ``EditedEventPools`` instead, whose entries may *cite* an
    # id — the one thing a create has nothing to do.
    pools: EventPools = Field(default_factory=list)

    #: The arm :meth:`_parse_draw_settings` parsed, kept rather than re-derived. Set by
    #: that validator and by nothing else; it cannot fall out of step with the two
    #: fields it was parsed from because a request model is **read-only after
    #: validation** — nothing assigns to ``draw_type``/``qualifiers_per_pool`` and
    #: nothing ``model_copy(update=…)``s one, which are the two gestures that would
    #: move a field without re-running the validator. It has no default because a model
    #: that exists has run the validator, and reading it on one that has not is a
    #: programmer error worth an ``AttributeError`` rather than a plausible-looking
    #: second parse.
    _draw_settings: DrawSettingsWriteArm = PrivateAttr()

    @property
    def draw_settings(self) -> DrawSettingsWriteArm:
        """The parsed draw configuration — the union arm this payload names.

        Total by the time anybody can call it **because the validator ran**:
        :meth:`_parse_draw_settings` parsed this pair during validation and kept the
        arm, so a model that exists is a model whose pair is legal and already parsed.
        The totality is the validator's, not this property's — which is why reading it
        twice (``create_event`` reads two attributes off it) costs one parse, not three.
        Callers take the *arm*, never the two loose fields, which is what keeps "which
        draw types carry a qualifier count" a fact stated in one place."""
        return self._draw_settings

    @model_validator(mode="after")
    def _parse_draw_settings(self) -> "TournamentEventCreate":
        """Parse at the boundary: an illegal ``(draw_type, qualifiers_per_pool)`` pair
        is a 422 on the create. This is now the **only** guard on that pairing — the
        settings table's ``CASE`` ``CHECK`` went away with the column it named (ADR "a
        draw type's settings are one NOT NULL JSON object"), so there is no longer a
        database refusal behind this one. The arm it parses is **kept**
        (:attr:`_draw_settings`) rather than discarded — parse once, at the boundary,
        and carry the parsed value inward."""
        self._draw_settings = _draw_settings_write(
            self.draw_type, self.qualifiers_per_pool
        )
        return self


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
    # **K**, patched *with* its draw type and never alone — see ``_parse_draw_settings``
    # below. An explicit ``null`` is meaningful here and means the same as absent from
    # the pair's point of view ("this draw type takes no qualifier count"), which is why
    # it is not in the ``_reject_explicit_null`` list.
    qualifiers_per_pool: QualifiersPerPool | None = None
    max_players: EventMaxPlayers | None = None
    entry_fee: EventEntryFee | None = None
    # The same validated IANA zone create requires — correcting the venue timezone is a
    # supported edit (ADR: "picked Chicago, the venue is Denver"). Its column is NOT
    # NULL, so an explicit ``null`` is rejected below; an unknown zone is still a 422.
    timezone: EventTimezone | None = None
    slot: Slot | None = None
    match_settings: MatchSettings | None = None
    predicates: list[Predicate] | None = None
    # ``EditedEventPools``, not the create shape: this is the verb that can *cite* a
    # pool, and citing is what makes the write a diff rather than a replace — a stored
    # pool an entry names keeps its row, and therefore every fixture drawn into it.
    # Hence the uniqueness rule lives here (``_pool_ids_are_unique``): it is the patch
    # path the pool-set freeze cannot cover, since the freeze compares SETS and
    # ``[A, A, B]`` is the same set as ``{A, B}``. A pool's ``position`` is not on this
    # shape either, so an editor that echoes one back gets a 422 naming the field; the
    # order it sends the list in is what re-orders the pools.
    pools: EditedEventPools | None = None

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
        # an explicit ``null`` is meaningful — it clears the cap (ADR-0935). So is
        # ``qualifiers_per_pool``, for the same reason in a different key: ``null``
        # there says "this draw type takes no qualifier count", which is exactly what
        # patching an ``rr-then-ko`` event back to a round-robin means.
        if value is None:
            raise ValueError("must not be null")
        return value

    #: The arm :meth:`_parse_draw_settings` parsed, or ``None`` when this patch does not
    #: touch the draw configuration. Kept rather than re-derived, exactly as the create
    #: schema's is — and here it is worth more, because the update path reads it twice
    #: (the freeze guard, then the write). ``None`` is a real answer on this verb, so
    #: unlike create's it carries that default.
    _draw_settings: DrawSettingsWriteArm | None = PrivateAttr(default=None)

    @property
    def draw_settings(self) -> DrawSettingsWriteArm | None:
        """The parsed draw configuration this patch asks for, or ``None`` when it is not
        patching the draw configuration at all.

        Total by the time anybody can call it, exactly as the create schema's is and
        for the same reason: :meth:`_parse_draw_settings` ran the parse during
        validation and kept the arm."""
        return self._draw_settings

    @model_validator(mode="after")
    def _parse_draw_settings(self) -> "TournamentEventUpdate":
        """The draw configuration is patched **as a unit**: a ``qualifiers_per_pool``
        without a ``draw_type`` beside it is a 422.

        Not pedantry — it is what keeps the pairing rule *at the boundary*. Which draw
        types carry a qualifier count is a fact about the ``(draw_type, K)`` pair, and a
        patch carrying only ``K`` does not hold that pair: judging it would mean reading
        the event's stored draw type, which happens two layers in, after the request has
        been accepted. Sending both is what the event editor does anyway — it PATCHes
        the form it rendered.

        The arm it parses is **kept** (:attr:`_draw_settings`) rather than discarded, so
        the freeze guard and the write that follows it read one parse between them."""
        if self.draw_type is None and self.qualifiers_per_pool is not None:
            raise ValueError(
                "qualifiers_per_pool is part of an event's draw configuration and is "
                "patched with it: send draw_type alongside it."
            )
        if self.draw_type is not None:
            self._draw_settings = _draw_settings_write(
                self.draw_type, self.qualifiers_per_pool
            )
        return self


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

    **Soft, deliberately — with one exception.** ``scheduled_start`` is a *prediction*,
    not a commitment, and three of the placement's four constraints — the table belongs
    to the fixture's pool, the time falls inside the pool's window, nothing is
    double-booked — are **flags derived on read, not invariants** (ADR-0790). So this
    write does **not** reject an out-of-window time or an off-pool table. They save.
    Conflict detection is the scheduler's business, not this boundary's.

    The exception is the fourth claim: **the table has to exist**. ``table_id`` names a
    ``TournamentTable.id`` in the tournament's ``table_catalogue``, and since the
    catalogue became real rows a fixture's ``table_id`` is a real **foreign key** into
    them, so an id that names no table is a **422 naming this field** rather than
    something stored and hoped about (ADR 20260801, "a placement names a real table, and
    only that is an invariant" — which supersedes exactly one clause of ADR-0790 and
    leaves the rest standing). The three flags are statements about a *relationship*
    between things that each legitimately move, so they must stay soft; "this id
    resolves to a table" is not one of those, and a placement whose table does not exist
    is a dangling pointer nothing downstream can render.

    The field carries the id's canonical **text** rather than a typed UUID, which is
    also what a pool's ``table_ids`` carry — one representation for a table id, moved in
    one piece rather than a field at a time. A value that is not a well-formed id is
    therefore refused by the same 422 as an unknown one: there is one question here
    ("does this name a table of this tournament?") and it gets one answer.

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

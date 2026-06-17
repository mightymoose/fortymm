import uuid
from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.models.tournament import DrawType, EventFormat, TournamentStatus

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


class Predicate(BaseModel):
    """An eligibility rule. ``value`` is a number (most fields), an enum key
    (gender), a boolean (club), or a ``[min, max]`` pair for the ``between``
    operator."""

    model_config = ConfigDict(extra="forbid")

    id: str
    field: Literal["age", "rating", "gender", "club"]
    op: str
    value: int | str | bool | list[int | None] | None


class TournamentTable(BaseModel):
    """A physical table in the venue catalogue, referenced by id from pools."""

    model_config = ConfigDict(extra="forbid")

    id: str
    label: str
    court: str


class Pool(BaseModel):
    """A slice of tables reserved for a window of time within an event."""

    model_config = ConfigDict(extra="forbid")

    id: str
    name: str
    slot: Slot
    table_ids: list[str]


# ----- read models ----------------------------------------------------------


class TournamentEventRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    tournament_id: uuid.UUID
    name: str
    format: EventFormat
    draw_type: DrawType
    max_players: int
    # Typed ``float`` so JSON emits a number, not a Decimal string. The
    # Numeric(8,2) column coerces cleanly into float at the read boundary.
    entry_fee: float
    entered: int
    slot: Slot
    match_settings: MatchSettings
    predicates: list[Predicate]
    pools: list[Pool]
    created_at: datetime
    updated_at: datetime


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
    created_by_user_id: uuid.UUID
    created_by_username: str
    can_edit: bool
    created_at: datetime
    updated_at: datetime


class TournamentDetailRead(TournamentRead):
    events: list[TournamentEventRead]


# ----- write models ---------------------------------------------------------


class TournamentCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=1024)
    status: TournamentStatus = TournamentStatus.draft
    start_date: date | None = None
    end_date: date | None = None
    address: Address
    table_catalogue: list[TournamentTable] = Field(default_factory=list)


class TournamentUpdate(BaseModel):
    """Partial update. A field that is *absent* is left unchanged; an explicit
    value replaces the current one. The columns backing ``name``, ``status``,
    and ``address`` are NOT NULL, so for those an explicit ``null`` is rejected
    (422) rather than allowed to reach the DB — "omitted" and "cleared" are
    different. ``description``/``start_date``/``end_date`` are nullable columns
    and may be cleared. ``table_catalogue`` replaces wholesale when present."""

    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=1024)
    status: TournamentStatus | None = None
    start_date: date | None = None
    end_date: date | None = None
    address: Address | None = None
    table_catalogue: list[TournamentTable] | None = None

    @field_validator("name", "status", "address", mode="before")
    @classmethod
    def _reject_explicit_null(cls, value: Any) -> Any:
        # These map to NOT NULL columns. ``mode="before"`` runs even when the
        # client sends an explicit ``null``; omitting the key entirely skips
        # the validator and keeps the default (the "absent" case).
        if value is None:
            raise ValueError("must not be null")
        return value


class TournamentEventCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=255)
    format: EventFormat
    draw_type: DrawType
    max_players: int = Field(gt=0)
    entry_fee: float = Field(ge=0)
    entered: int = 0
    slot: Slot
    match_settings: MatchSettings
    predicates: list[Predicate] = Field(default_factory=list)
    pools: list[Pool] = Field(default_factory=list)


class TournamentEventUpdate(BaseModel):
    """Partial update for an event. Absent fields are unchanged. The columns
    backing ``name``/``format``/``draw_type``/``max_players``/``entry_fee``/
    ``entered``/``slot``/``match_settings`` are NOT NULL, so an explicit
    ``null`` on any of them is rejected (422). ``entered`` is nullable-typed
    only to allow omission; it is never legitimately clearable to null.
    ``predicates``/``pools`` replace wholesale when present."""

    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=255)
    format: EventFormat | None = None
    draw_type: DrawType | None = None
    max_players: int | None = Field(default=None, gt=0)
    entry_fee: float | None = Field(default=None, ge=0)
    entered: int | None = None
    slot: Slot | None = None
    match_settings: MatchSettings | None = None
    predicates: list[Predicate] | None = None
    pools: list[Pool] | None = None

    @field_validator(
        "name",
        "format",
        "draw_type",
        "max_players",
        "entry_fee",
        "entered",
        "slot",
        "match_settings",
        mode="before",
    )
    @classmethod
    def _reject_explicit_null(cls, value: Any) -> Any:
        if value is None:
            raise ValueError("must not be null")
        return value

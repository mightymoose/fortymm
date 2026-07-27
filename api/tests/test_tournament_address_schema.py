"""The venue value-object boundary: optional, blank-normalized, bounded on write only.

A tournament **may have no venue** — announced before the venue is booked, or a small
private tournament deliberately withholding its address (CONTEXT.md, "Venue"; the
2026-07-26 amendment to the geocoding ADR). Before #1206 that state was unreachable
through every write path and unreadable through every read path.

These are pure schema tests — no HTTP, no database — because every rule under test is a
rule of the value-object boundary itself, and asserting them here pins them
independently of whichever verb happens to call them. The verbs' end-to-end behaviour
(what a create with no venue *stores*, what a PATCH ``null`` *clears*) is asserted where
those verbs live.
"""

import uuid
from datetime import UTC, datetime
from typing import Any

import pytest
from pydantic import ValidationError

from app.models.tournament import TournamentStatus
from app.schemas.tournament import (
    MAX_ADDRESS_COMPONENT,
    Address,
    AddressInput,
    TournamentCreate,
    TournamentRead,
    TournamentUpdate,
)

#: The six free-text components, named once. Parametrizing over them is what makes the
#: length bound a property of *the address* rather than of ``venue``, which is the only
#: one anybody ever types into by hand in a test.
ADDRESS_COMPONENTS = ("venue", "street", "city", "region", "postal", "country")


def _blank_address(**overrides: str) -> dict[str, str]:
    """The six components, all empty, with ``overrides`` filled in."""
    return {component: "" for component in ADDRESS_COMPONENTS} | overrides


def _full_address() -> dict[str, str]:
    return {
        "venue": "Broadway Table Tennis",
        "street": "1 Main St",
        "city": "Chicago",
        "region": "IL",
        "postal": "60625",
        "country": "US",
    }


def _stored_address(**overrides: Any) -> dict[str, Any]:
    """A stored address: the six components plus the coordinates the server geocoded."""
    return _full_address() | {"latitude": 41.9, "longitude": -87.7} | overrides


def _tournament_read_payload(**overrides: Any) -> dict[str, Any]:
    now = datetime.now(UTC)
    return {
        "id": uuid.uuid4(),
        "name": "Summer Open",
        "description": None,
        "status": TournamentStatus.draft,
        "start_date": None,
        "end_date": None,
        "address": _stored_address(),
        "table_catalogue": [],
        "league_id": uuid.uuid4(),
        "created_by_user_id": uuid.uuid4(),
        "created_by_username": "director",
        "can_edit": True,
        "created_at": now,
        "updated_at": now,
    } | overrides


# ----- the read shape admits "no venue" -------------------------------------


def test_read_accepts_a_null_address():
    """A tournament with no venue must be *readable*.

    This is the failure the bug reduced to: ``tournaments.address`` is nullable, and a
    ``TournamentRead`` that insisted on an ``Address`` raised ``ValidationError``
    ("Input should be a valid dictionary or instance of Address") the moment such a row
    reached a serializer — taking the list and the dashboard down with it.
    """
    read = TournamentRead.model_validate(_tournament_read_payload(address=None))

    assert read.address is None


def test_read_still_carries_a_present_address_with_its_coordinates():
    """Making the address optional must not make its *coordinates* optional.

    The deliberate non-choice recorded in the ADR amendment: ``latitude``/``longitude``
    stay NOT NULL *within* an address, so the one new state is "no venue" and never the
    half-populated "venue text, location unknown" that every reader would have to
    defend against.
    """
    read = TournamentRead.model_validate(_tournament_read_payload())

    assert read.address is not None
    assert (read.address.latitude, read.address.longitude) == (41.9, -87.7)


# ----- all-blank normalizes to "no venue", before anything geocodes ---------


@pytest.mark.parametrize(
    ("blank", "label"),
    [
        (_blank_address(), "six empty strings"),
        (
            _blank_address(
                venue=" ", street="\t", city="\n", region="  ", postal=" ", country=" "
            ),
            "whitespace only",
        ),
    ],
    ids=lambda value: value if isinstance(value, str) else "",
)
def test_an_all_blank_create_address_is_no_venue(blank: dict[str, str], label: str):
    """An all-blank address parses to ``None``, not to an object of six empty strings.

    This is the rule that makes "no venue" reachable at all. The web form submits six
    controlled text inputs and has no gesture meaning "the ``address`` key is absent",
    so without this the browser organizer — the person #1206 is about — is still refused
    for leaving the venue empty (a blank address geocodes to zero candidates, which is a
    coded 409). Normalizing here, at the boundary, also keeps SQL ``NULL`` the *single*
    representation of "no venue": six empty strings would be a second one.
    """
    created = TournamentCreate(name="Summer Open", address=blank)

    assert created.address is None


def test_an_omitted_create_address_is_no_venue():
    created = TournamentCreate(name="Summer Open")

    assert created.address is None


def test_one_filled_component_is_still_a_venue():
    """Only *all* blank is "no venue" — a partial address is an address.

    The guard against over-normalizing: "Chicago" with nothing else filled in is
    something an organizer meant, and it geocodes fine. If this reds, the normalizer has
    become an any-blank rule and is silently discarding venues.
    """
    created = TournamentCreate(
        name="Summer Open", address=_blank_address(city="Chicago")
    )

    assert created.address == AddressInput(**_blank_address(city="Chicago"))


def test_an_all_blank_patch_address_is_a_removal_not_an_omission():
    """All-blank on PATCH normalizes to ``None`` **and stays in ``model_fields_set``**.

    The value alone cannot distinguish "absent" from "remove" once ``None`` means
    remove, so the disambiguator is the field-set — and normalization must not disturb
    it. An ``AfterValidator`` runs only on a field that was supplied, which is exactly
    why "remove" survives here and "unchanged" survives below.
    """
    updates = TournamentUpdate(address=_blank_address())

    assert updates.address is None
    assert "address" in updates.model_fields_set


def test_an_omitted_patch_address_is_absent_from_the_field_set():
    updates = TournamentUpdate(name="Renamed")

    assert updates.address is None
    assert "address" not in updates.model_fields_set


# ----- an explicit null is a legitimate patch --------------------------------


def test_patch_accepts_an_explicit_null_address():
    """``TournamentUpdate`` no longer refuses ``address: null``.

    It used to, justified as "these map to NOT NULL columns" — a reason that is now
    false for ``tournaments.address`` (#1206). Keeping the rejection would have enforced
    a constraint the database does not have, leaving an organizer no way to un-book a
    venue. What the accepted ``null`` then *does* to the stored row is the edit verb's
    claim, not this schema's.
    """
    updates = TournamentUpdate(address=None)

    assert updates.address is None
    assert "address" in updates.model_fields_set


@pytest.mark.parametrize("field", ["name", "table_catalogue", "league_id"])
def test_patch_still_rejects_an_explicit_null_for_the_not_null_columns(field: str):
    """Only ``address`` left the rejected-``null`` set; the genuinely NOT NULL columns
    stay in it. Without this, dropping ``address`` from the validator's field list by
    hand could quietly drop a neighbour too."""
    with pytest.raises(ValidationError):
        TournamentUpdate.model_validate({field: None})


# ----- the 255 bound is on the write shape ONLY ------------------------------


@pytest.mark.parametrize("component", ADDRESS_COMPONENTS)
def test_an_over_long_component_is_refused_on_create(component: str):
    with pytest.raises(ValidationError) as excinfo:
        TournamentCreate(
            name="Summer Open",
            address=_full_address() | {component: "x" * (MAX_ADDRESS_COMPONENT + 1)},
        )

    errors = excinfo.value.errors()
    assert [error["type"] for error in errors] == ["string_too_long"]
    assert errors[0]["loc"] == ("address", component)


@pytest.mark.parametrize("component", ADDRESS_COMPONENTS)
def test_an_over_long_component_is_refused_on_patch(component: str):
    """The patch path is the same hole wearing a different verb: a value that cannot be
    created must not be reachable by editing. Both schemas share one alias, which is
    what makes them impossible to drift apart."""
    with pytest.raises(ValidationError):
        TournamentUpdate(
            address=_full_address() | {component: "x" * (MAX_ADDRESS_COMPONENT + 1)}
        )


def test_a_component_of_exactly_the_maximum_is_accepted():
    """The bound is inclusive — 255 is a legal length, 256 is not. Pins which side of
    the boundary the off-by-one lives on, so a later ``lt``/``le`` slip reds here."""
    at_the_limit = "x" * MAX_ADDRESS_COMPONENT

    created = TournamentCreate(
        name="Summer Open", address=_full_address() | {"venue": at_the_limit}
    )

    assert created.address is not None
    assert created.address.venue == at_the_limit


@pytest.mark.parametrize("component", ADDRESS_COMPONENTS)
def test_an_over_long_stored_component_still_reads_back(component: str):
    """The read shape is **unbounded**, so history that predates the bound stays
    readable.

    This is the asymmetry, and getting it backwards is the outage: a ``max_length`` on
    :class:`Address` would make every read of an over-long row raise, and one such row
    would take down the whole dashboard — precisely the class of defect this arc is
    fixing elsewhere. Write boundaries tighten; read boundaries stay permissive about
    what is already stored.
    """
    over_long = "x" * 700

    read = TournamentRead.model_validate(
        _tournament_read_payload(address=_stored_address(**{component: over_long}))
    )

    assert read.address is not None
    assert getattr(read.address, component) == over_long


def test_the_stored_address_model_itself_is_unbounded():
    """The same claim one layer down, on :class:`Address` directly — so the guarantee is
    pinned to the model rather than to ``TournamentRead`` happening to embed it."""
    stored = Address.model_validate(_stored_address(venue="v" * 700))

    assert len(stored.venue) == 700

"""Geocode a venue ``AddressInput`` into a stored ``Address`` at write time.

The one place the tournament write verbs turn the six free-text address components a
client sends (:class:`~app.schemas.tournament.AddressInput`) into the stored
value-object that also carries coordinates (:class:`~app.schemas.tournament.Address`),
by asking the injected :class:`~app.geocoding.Geocoder` (ADR "a venue's coordinates are
geocoded server-side at write time and are NOT NULL"). Shared by ``create_tournament``
(``app.tournament_lifecycle``) and ``edit_tournament`` (``app.tournament_edit``) so both
verbs geocode through one composition and one code path.

FastAPI-free on purpose — the verbs that import it must stay constructible without
FastAPI (``api/CLAUDE.md``, "service layer and dependency injection"). It builds the
:class:`Address`, which lives in the tournament layer, rather than the geocoding seam
building it: :func:`~app.geocoding.compose_address` is kept generic precisely so the
seam does not import the tournament schema.

A zero-result lookup raises :class:`~app.geocoding.AddressNotGeocodableError`, which
these verbs let propagate to their transport adapter — the HTTP handler maps it to a
coded ``409`` (:class:`AddressNotGeocodable`) and the MCP tool to a ``ToolError``, both
carrying the machine-readable :data:`ADDRESS_NOT_GEOCODABLE_CODE` (ADR-0968's
coded-refusal convention). It is a ``409``, not a ``422``: FastAPI reserves ``422`` for
its own ``HTTPValidationError`` (a ``detail`` **array**), so a hand-rolled ``422``
object body collides with the shape the generated clients expect there (ADR-0968). Every
other geocoder failure (:class:`~app.geocoding.GeocoderError`) is unexpected and
propagates to the ``500`` handler — it is not caught here.
"""

from pydantic import BaseModel, ConfigDict

from app.geocoding import Geocoder, compose_address
from app.schemas.tournament import Address, AddressInput

#: The stable machine-readable code a client (and the MCP agent) switches on when a
#: venue address cannot be geocoded (ADR-0968's coded-refusal convention). The HTTP
#: adapter puts it in the coded ``409`` ``{"detail": {"code", "message"}}`` body and the
#: MCP adapter names it in the ``ToolError`` prose, so both surfaces carry the same word
#: for the same refusal. Defined here, FastAPI-free, so both adapters share one source
#: and cannot drift.
ADDRESS_NOT_GEOCODABLE_CODE = "address_not_geocodable"

#: The human sentence paired with :data:`ADDRESS_NOT_GEOCODABLE_CODE` — the fallback a
#: client without copy for the code, or a person, reads. The code is the contract; this
#: is prose, so rewording it is safe.
ADDRESS_NOT_GEOCODABLE_MESSAGE = (
    "We couldn't locate that address. Check the venue, street, city, region, postal "
    "code and country, then try again."
)


class AddressNotGeocodable(BaseModel):
    """The ``409`` response body for a venue address that resolved to zero geocoding
    candidates — the coded-refusal convention of ADR-0968, mirroring the entry
    endpoint's ``{"code", "message"}`` shape.

    ``code`` is the stable contract a client switches on — always
    :data:`ADDRESS_NOT_GEOCODABLE_CODE`, carried as the field's default so the one
    constant is the single source of the string (no fork) and the concrete value
    still surfaces in the generated OpenAPI. ``message`` is fallback prose for a
    client without copy for the code, or a person.

    Modeled (rather than a hand-rolled ``dict`` detail) so the create/edit/preview
    routes' ``responses={409: {"model": AddressNotGeocodable}}`` describes the body
    the generated web + iOS types actually receive — instead of the refusal riding on
    FastAPI's reserved ``422``, whose auto-generated ``HTTPValidationError`` schema
    says ``detail`` is an **array** and so cannot decode this object body (ADR-0968).
    Pure Pydantic, kept beside the code/message it carries; the FastAPI
    ``HTTPException`` that wraps it lives in the router adapter (``app.tournaments``),
    so this module stays FastAPI-free."""

    model_config = ConfigDict(extra="forbid")

    code: str = ADDRESS_NOT_GEOCODABLE_CODE
    message: str


async def geocode_address(geocoder: Geocoder, address: AddressInput) -> Address:
    """Geocode ``address`` and return the stored :class:`Address` (its six text fields
    plus the resolved ``latitude`` / ``longitude``).

    Composes the six components into one geocodable string
    (:func:`~app.geocoding.compose_address`), asks ``geocoder`` for the top candidate,
    and carries the client's typed text through unchanged — only the coordinates come
    from the geocoder (the ADR stores coordinates only, leaving the free text as
    entered).

    Raises :class:`~app.geocoding.AddressNotGeocodableError` when the address resolves
    to zero candidates; the caller maps it to a coded ``409``. Any other geocoder
    failure propagates.
    """
    # ``AddressInput`` holds exactly ``compose_address``'s six keyword params, and
    # ``Address`` is those same six plus the coordinates, so one ``model_dump`` feeds
    # both without re-listing the field names (``extra="forbid"`` keeps it honest).
    components = address.model_dump()
    result = await geocoder.geocode(compose_address(**components))
    return Address(
        **components,
        latitude=result.latitude,
        longitude=result.longitude,
    )

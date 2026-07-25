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
these verbs let propagate to their transport adapter — the HTTP handler and the MCP
tool each map it to a ``422`` carrying the machine-readable
:data:`ADDRESS_NOT_GEOCODABLE_CODE` (ADR-0968's coded-refusal convention). Every other
geocoder failure (:class:`~app.geocoding.GeocoderError`) is unexpected and propagates to
the ``500`` handler — it is not caught here.
"""

from app.geocoding import Geocoder, compose_address
from app.schemas.tournament import Address, AddressInput

#: The stable machine-readable code a client (and the MCP agent) switches on when a
#: venue address cannot be geocoded (ADR "an unresolvable address is a 422 at the
#: boundary"). The HTTP adapter puts it in the coded ``{"detail": {"code", "message"}}``
#: body and the MCP adapter names it in the ``ToolError`` prose, so both surfaces carry
#: the same word for the same refusal. Defined here, FastAPI-free, so both adapters
#: share one source and cannot drift.
ADDRESS_NOT_GEOCODABLE_CODE = "address_not_geocodable"

#: The human sentence paired with :data:`ADDRESS_NOT_GEOCODABLE_CODE` — the fallback a
#: client without copy for the code, or a person, reads. The code is the contract; this
#: is prose, so rewording it is safe.
ADDRESS_NOT_GEOCODABLE_MESSAGE = (
    "We couldn't locate that address. Check the venue, street, city, region, postal "
    "code and country, then try again."
)


async def geocode_address(geocoder: Geocoder, address: AddressInput) -> Address:
    """Geocode ``address`` and return the stored :class:`Address` (its six text fields
    plus the resolved ``latitude`` / ``longitude``).

    Composes the six components into one geocodable string
    (:func:`~app.geocoding.compose_address`), asks ``geocoder`` for the top candidate,
    and carries the client's typed text through unchanged — only the coordinates come
    from the geocoder (the ADR stores coordinates only, leaving the free text as
    entered).

    Raises :class:`~app.geocoding.AddressNotGeocodableError` when the address resolves
    to zero candidates; the caller maps it to a coded ``422``. Any other geocoder
    failure propagates.
    """
    result = await geocoder.geocode(
        compose_address(
            venue=address.venue,
            street=address.street,
            city=address.city,
            region=address.region,
            postal=address.postal,
            country=address.country,
        )
    )
    return Address(
        venue=address.venue,
        street=address.street,
        city=address.city,
        region=address.region,
        postal=address.postal,
        country=address.country,
        latitude=result.latitude,
        longitude=result.longitude,
    )

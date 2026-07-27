"""Server-side geocoding seam.

A venue is geocoded server-side on write (ADR "a venue's coordinates are
geocoded server-side and not null"): coordinates are never accepted from the
client and never written null. The geocoder is an **injectable seam** — the
interior of the app depends on the ``Geocoder`` protocol, not a concrete
client — so handlers and tests substitute an implementation the same way the
match layer substitutes a ``RatingCalculator`` / ``PushSender``.

Three pieces live here:

* ``Geocoder`` — the protocol every implementation satisfies: one async
  ``geocode(address: str) -> GeocodeResult``.
* ``GoogleGeocoder`` — the real implementation, calling the Google Geocoding
  API over an injected ``httpx.AsyncClient``. It never touches the network at
  construction time, only inside ``geocode``.
* ``FakeGeocoder`` — a deterministic, network-free implementation, selected only
  when an environment asks for it by name with ``GEOCODER=fake`` (see its
  docstring for the stable mapping and the unresolvable sentinel).

A lookup that resolves to zero candidates is an **expected** failure the caller
turns into a ``422`` — it is raised as ``AddressNotGeocodableError`` and is the
only failure a caller is expected to catch. Anything else (a transport error, a
Google status like ``REQUEST_DENIED``) is genuinely unexpected and propagates.
"""

from __future__ import annotations

import hashlib
from typing import Protocol

import httpx
from pydantic import BaseModel, ConfigDict, Field

#: Google's forward-geocoding endpoint (address -> coordinates).
GOOGLE_GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json"

#: The sentinel token the :class:`FakeGeocoder` treats as unresolvable. Any
#: address whose *normalized* form contains this token — or normalizes to the
#: empty string — raises :class:`AddressNotGeocodableError` instead of returning
#: coordinates. Later chores (the create/edit 422 tests, the near-me e2e test)
#: rely on this being stable and network-free.
UNRESOLVABLE_SENTINEL = "__unresolvable__"


class GeocodeResult(BaseModel):
    """The typed result of a successful geocode — a single resolved location.

    Frozen so a resolved location cannot be mutated after it crosses the seam,
    and range-validated so an implementation cannot hand back a latitude or
    longitude outside the real coordinate space (``make illegal states
    unrepresentable``). Carries the provider's canonical ``formatted`` label so
    a caller can echo back the normalized address it actually matched.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    latitude: float = Field(ge=-90.0, le=90.0)
    longitude: float = Field(ge=-180.0, le=180.0)
    formatted: str


class AddressNotGeocodableError(Exception):
    """The address resolved to zero candidates — it cannot be geocoded.

    The **only** expected failure a caller handles: the write verbs map it to a
    ``422`` rather than writing null coordinates. Every other failure mode
    (transport errors, non-``OK``/non-``ZERO_RESULTS`` provider statuses) is
    unexpected and is allowed to propagate.
    """

    def __init__(self, address: str) -> None:
        self.address = address
        super().__init__(f"Address could not be geocoded: {address!r}")


class GeocoderError(Exception):
    """An unexpected geocoding-provider failure (not a zero-result lookup).

    Distinct from :class:`AddressNotGeocodableError` precisely so callers do not
    accidentally turn a provider misconfiguration (``REQUEST_DENIED``) or quota
    exhaustion (``OVER_QUERY_LIMIT``) into a client-facing ``422``. It carries a
    server fault to the 500 handler instead.
    """


class Geocoder(Protocol):
    """A service that resolves a free-form address string to coordinates.

    Implementations take a single composed address string (build one from the
    venue value-object fields with :func:`compose_address`) so the same seam
    serves both the write verbs and a later address-preview endpoint.
    """

    async def geocode(self, address: str) -> GeocodeResult:
        """Resolve ``address`` to its top-ranked location.

        Raises :class:`AddressNotGeocodableError` when the address resolves to
        zero candidates.
        """
        ...


def compose_address(
    *,
    venue: str,
    street: str,
    city: str,
    region: str,
    postal: str,
    country: str,
) -> str:
    """Compose the venue value-object fields into a single geocodable string.

    Kept here (rather than importing the ``Address`` schema, which would couple
    the seam to the tournament layer) so both the write verbs and a preview
    endpoint share one composition. Empty/whitespace-only parts are dropped so a
    partially filled address still composes cleanly.
    """
    parts = (venue, street, city, region, postal, country)
    return ", ".join(part.strip() for part in parts if part.strip())


def _normalize(address: str) -> str:
    """Case-fold and collapse whitespace so trivially different spellings of the
    same address map to the same deterministic result in :class:`FakeGeocoder`."""
    return " ".join(address.lower().split())


class _GoogleLocation(BaseModel):
    lat: float
    lng: float


class _GoogleGeometry(BaseModel):
    location: _GoogleLocation


class _GoogleResult(BaseModel):
    formatted_address: str
    geometry: _GoogleGeometry


class _GoogleResponse(BaseModel):
    """The slice of Google's Geocoding response we consume, parsed at the
    boundary (parse-at-boundaries) so the interior holds typed fields rather
    than a ``dict[str, Any]`` indexed by string keys."""

    status: str
    results: list[_GoogleResult] = Field(default_factory=list)


class GoogleGeocoder:
    """The real geocoder, backed by the Google Geocoding API.

    The ``httpx.AsyncClient`` is injected so the network is a substitutable seam
    (a test can pass a client wired to a mock transport). Construction performs
    no I/O; the network is only touched inside :meth:`geocode`.
    """

    def __init__(self, api_key: str, client: httpx.AsyncClient) -> None:
        self._api_key = api_key
        self._client = client

    async def geocode(self, address: str) -> GeocodeResult:
        response = await self._client.get(
            GOOGLE_GEOCODE_URL,
            params={"address": address, "key": self._api_key},
        )
        response.raise_for_status()
        body = _GoogleResponse.model_validate(response.json())

        if body.status == "ZERO_RESULTS":
            raise AddressNotGeocodableError(address)
        if body.status != "OK":
            # REQUEST_DENIED / OVER_QUERY_LIMIT / INVALID_REQUEST etc. — a
            # provider/configuration fault, not "no such place". Propagate.
            raise GeocoderError(f"Google Geocoding API returned status {body.status!r}")
        if not body.results:
            raise AddressNotGeocodableError(address)

        top = body.results[0]
        return GeocodeResult(
            latitude=top.geometry.location.lat,
            longitude=top.geometry.location.lng,
            formatted=top.formatted_address,
        )


class FakeGeocoder:
    """A deterministic, network-free geocoder for tests and local environments.

    Never selected by default — an environment gets this only by naming it,
    ``GEOCODER=fake``. It stays in the codebase because requiring a real key in
    deployed environments does not obviate the double: the suite needs stable
    coordinates to assert on, :data:`UNRESOLVABLE_SENTINEL` exercises the
    zero-result path with no network call, and CI would otherwise need a live
    key, egress and quota per run — which PRs from forks cannot have.

    Determinism is the whole point: a given address always maps to the same
    coordinates, so later chores can assert exact values (the near-me e2e test
    needs known coordinates) and the create/edit 422 tests need a reliable way
    to force the no-result path.

    * **Normal address** — the normalized address string (case-folded,
      whitespace-collapsed) is SHA-256 hashed; the first four bytes seed a
      latitude in ``[-90, 90)`` and the next four a longitude in ``[-180, 180)``.
      Same input, same coordinates, every run, on every machine.
    * **Unresolvable sentinel** — an address whose normalized form is empty, or
      contains the literal token :data:`UNRESOLVABLE_SENTINEL`
      (``"__unresolvable__"``), raises :class:`AddressNotGeocodableError`. This
      is the designated input a test uses to exercise the zero-result → 422 path
      without a network call.
    """

    async def geocode(self, address: str) -> GeocodeResult:
        normalized = _normalize(address)
        if not normalized or UNRESOLVABLE_SENTINEL in normalized:
            raise AddressNotGeocodableError(address)

        digest = hashlib.sha256(normalized.encode("utf-8")).digest()
        lat_raw = int.from_bytes(digest[0:4], "big")
        lng_raw = int.from_bytes(digest[4:8], "big")
        latitude = (lat_raw / 2**32) * 180.0 - 90.0
        longitude = (lng_raw / 2**32) * 360.0 - 180.0

        return GeocodeResult(
            latitude=latitude,
            longitude=longitude,
            formatted=address.strip(),
        )

"""Unit tests for the geocoding seam (chore 1a).

None of these touch the network or a database: they exercise the deterministic
``FakeGeocoder`` and the key-driven provider selection directly, and drive
``GoogleGeocoder`` through an ``httpx`` mock transport.
"""

from __future__ import annotations

import httpx
import pytest

from app.config import Settings
from app.geocoding.dependencies import get_geocoder
from app.geocoding.geocoder import (
    UNRESOLVABLE_SENTINEL,
    AddressNotGeocodableError,
    FakeGeocoder,
    GeocoderError,
    GoogleGeocoder,
    compose_address,
)

A_NORMAL_ADDRESS = "1600 Amphitheatre Parkway, Mountain View, CA 94043, USA"


# --- provider selection -----------------------------------------------------


def test_provider_returns_google_geocoder_when_key_is_set() -> None:
    settings = Settings(google_geocoding_api_key="a-real-looking-key")
    geocoder = get_geocoder(settings=settings)
    assert isinstance(geocoder, GoogleGeocoder)


def test_provider_returns_fake_geocoder_when_no_key() -> None:
    settings = Settings(google_geocoding_api_key=None)
    geocoder = get_geocoder(settings=settings)
    assert isinstance(geocoder, FakeGeocoder)


def test_provider_treats_empty_string_key_as_unconfigured() -> None:
    settings = Settings(google_geocoding_api_key="")
    geocoder = get_geocoder(settings=settings)
    assert isinstance(geocoder, FakeGeocoder)


# --- FakeGeocoder: determinism ----------------------------------------------


async def test_fake_geocoder_is_deterministic() -> None:
    fake = FakeGeocoder()
    first = await fake.geocode(A_NORMAL_ADDRESS)
    second = await fake.geocode(A_NORMAL_ADDRESS)
    assert first == second


async def test_fake_geocoder_coordinates_are_in_range() -> None:
    fake = FakeGeocoder()
    result = await fake.geocode(A_NORMAL_ADDRESS)
    assert -90.0 <= result.latitude <= 90.0
    assert -180.0 <= result.longitude <= 180.0
    assert result.formatted == A_NORMAL_ADDRESS


async def test_fake_geocoder_normalizes_before_hashing() -> None:
    fake = FakeGeocoder()
    spaced = await fake.geocode("  1600   Amphitheatre  Parkway  ")
    tidy = await fake.geocode("1600 Amphitheatre Parkway")
    assert (spaced.latitude, spaced.longitude) == (tidy.latitude, tidy.longitude)


async def test_fake_geocoder_maps_distinct_addresses_apart() -> None:
    fake = FakeGeocoder()
    one = await fake.geocode("Somewhere, City A")
    two = await fake.geocode("Elsewhere, City B")
    assert (one.latitude, one.longitude) != (two.latitude, two.longitude)


# --- FakeGeocoder: the unresolvable sentinel --------------------------------


async def test_fake_geocoder_raises_for_the_sentinel_token() -> None:
    fake = FakeGeocoder()
    address = compose_address(
        venue=UNRESOLVABLE_SENTINEL,
        street="1 Nowhere Rd",
        city="Nulltown",
        region="NA",
        postal="00000",
        country="Nowhereland",
    )
    with pytest.raises(AddressNotGeocodableError):
        await fake.geocode(address)


async def test_fake_geocoder_raises_for_empty_address() -> None:
    fake = FakeGeocoder()
    with pytest.raises(AddressNotGeocodableError):
        await fake.geocode("   ")


# --- GoogleGeocoder: no real network, via a mock transport ------------------


def _google_client(handler: httpx.MockTransport) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=handler)


async def test_google_geocoder_takes_the_top_candidate() -> None:
    def handle(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "status": "OK",
                "results": [
                    {
                        "formatted_address": "Top Match, City",
                        "geometry": {"location": {"lat": 37.42, "lng": -122.08}},
                    },
                    {
                        "formatted_address": "Runner Up, City",
                        "geometry": {"location": {"lat": 1.0, "lng": 2.0}},
                    },
                ],
            },
        )

    async with _google_client(httpx.MockTransport(handle)) as client:
        geocoder = GoogleGeocoder(api_key="k", client=client)
        result = await geocoder.geocode(A_NORMAL_ADDRESS)

    assert result.latitude == 37.42
    assert result.longitude == -122.08
    assert result.formatted == "Top Match, City"


async def test_google_geocoder_raises_not_geocodable_on_zero_results() -> None:
    def handle(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"status": "ZERO_RESULTS", "results": []})

    async with _google_client(httpx.MockTransport(handle)) as client:
        geocoder = GoogleGeocoder(api_key="k", client=client)
        with pytest.raises(AddressNotGeocodableError):
            await geocoder.geocode(A_NORMAL_ADDRESS)


async def test_google_geocoder_propagates_provider_error_status() -> None:
    def handle(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"status": "REQUEST_DENIED", "results": []})

    async with _google_client(httpx.MockTransport(handle)) as client:
        geocoder = GoogleGeocoder(api_key="k", client=client)
        with pytest.raises(GeocoderError):
            await geocoder.geocode(A_NORMAL_ADDRESS)

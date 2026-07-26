"""FastAPI wiring for the geocoding seam — the single place that decides which
:class:`~app.geocoding.geocoder.Geocoder` a handler receives.

The choice is key-driven: when ``GOOGLE_GEOCODING_API_KEY`` is configured the
provider hands out a :class:`GoogleGeocoder`; otherwise (local dev, CI, tests) a
network-free :class:`FakeGeocoder`. Handlers declare
``geocoder: Geocoder = Depends(get_geocoder)`` and tests override it via
``app.dependency_overrides`` — mirroring the service-layer rules in
``api/CLAUDE.md``.

The ``httpx.AsyncClient`` behind the real geocoder is a process-wide singleton
(a connection pool with no request state, like the notifications ``PushSender``),
not a request-scoped resource.
"""

from __future__ import annotations

import httpx
from fastapi import Depends

from app.config import Settings, get_settings
from app.geocoding.geocoder import FakeGeocoder, Geocoder, GoogleGeocoder

#: Shared connection pool for the real geocoder. Constructed lazily-pooled by
#: httpx (no socket work at import), so importing this module performs no I/O.
_client = httpx.AsyncClient(timeout=5.0)


def get_geocoder(settings: Settings = Depends(get_settings)) -> Geocoder:
    """Return the geocoder implied by configuration.

    ``GoogleGeocoder`` when ``GOOGLE_GEOCODING_API_KEY`` is set, otherwise the
    deterministic ``FakeGeocoder``. Selection reads ``Settings`` so tests can
    exercise both branches by constructing/overriding ``Settings`` rather than
    mutating the process environment.
    """
    api_key = settings.google_geocoding_api_key
    if api_key:
        return GoogleGeocoder(api_key=api_key, client=_client)
    return FakeGeocoder()

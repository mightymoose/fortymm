"""FastAPI wiring for the geocoding seam — the single place that decides which
:class:`~app.geocoding.geocoder.Geocoder` a handler receives.

The choice is **explicit configuration**: the ``GEOCODER`` setting names the
implementation (``google`` | ``fake``) and nothing here infers it from whether a
key happens to be present. ``GEOCODER`` defaults to ``google``, and ``Settings``
itself refuses to construct a keyless ``google`` configuration, so there is no
path where silence hands out the test double — the double must be asked for by
name (see the 2026-07-26 amendment to the ADR "a venue's coordinates are
geocoded server-side and not null"). Handlers declare
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

from app.config import GeocoderChoice, Settings, get_settings
from app.geocoding.geocoder import FakeGeocoder, Geocoder, GoogleGeocoder

#: Shared connection pool for the real geocoder. Constructed lazily-pooled by
#: httpx (no socket work at import), so importing this module performs no I/O.
_client = httpx.AsyncClient(timeout=5.0)


def get_geocoder(settings: Settings = Depends(get_settings)) -> Geocoder:
    """Return the geocoder the ``GEOCODER`` setting names.

    The setting decides, not the presence of a key: ``fake`` yields the
    deterministic ``FakeGeocoder`` even with a Google key configured, and
    ``google`` yields the ``GoogleGeocoder``. Selection reads ``Settings`` so
    tests exercise both branches by constructing/overriding ``Settings`` rather
    than mutating the process environment. The match is exhaustive with no
    catch-all, so a new member of ``GeocoderChoice`` is a type error here until
    it is handled.
    """
    match settings.geocoder:
        case GeocoderChoice.FAKE:
            return FakeGeocoder()
        case GeocoderChoice.GOOGLE:
            api_key = settings.google_geocoding_api_key
            if not api_key:
                # Unreachable via a validated ``Settings`` — the model-level
                # validator rejects keyless ``google`` at construction. Kept
                # because it is what narrows ``str | None`` to ``str`` for the
                # type checker, and a bypassed model (``model_construct``)
                # should still fail loudly rather than call Google with no key.
                raise RuntimeError(
                    "GEOCODER is 'google' but GOOGLE_GEOCODING_API_KEY is unset."
                )
            return GoogleGeocoder(api_key=api_key, client=_client)

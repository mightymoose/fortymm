"""Domain facts about the default role every user holds, independent of any one
surface that stores or serializes it.

Storage-agnostic and framework-agnostic: no SQLAlchemy, no Pydantic, no FastAPI.
Both the persistence side (``app.roles`` — guest-mint's grant, the seed's
convergence) and the wire side (``app.schemas.rbac.RoleRead.is_default``) import
the name from here, so the schema layer stays dependency-light instead of
dragging the ORM in to read one string.

The name is load-bearing — guest-mint looks the role up by it, and the
delete/rename guard defends it — so it lives in exactly one constant. See
``docs/adr/0016-every-user-holds-the-default-user-role.md``.
"""

from __future__ import annotations

DEFAULT_ROLE_NAME = "User"
DEFAULT_ROLE_DESCRIPTION = (
    "Held by every user. Carries no permissions by default — add one here to "
    "grant it to the whole population, including anonymous visitors."
)

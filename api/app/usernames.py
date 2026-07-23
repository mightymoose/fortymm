"""Username-slug generation, router-free so any provisioning path can import it.

Deliberately free of FastAPI imports (just SQLAlchemy ``AsyncSession`` +
``coolname`` + the ``User`` model) so both the cookie-session mint in
``app.sessions`` and the Auth0-provisioning path can share one generator without
dragging in the heavy session router or risking an import cycle.
"""

from coolname import generate_slug
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import User


async def generate_username(db: AsyncSession) -> str:
    """Return a fresh, unique two-word slug username (e.g. ``brave-otter``).

    Generates a ``coolname`` two-word slug and, if it (case-insensitively)
    collides with an existing username, appends the lowest free ``-N`` suffix.
    """
    base = generate_slug(2)
    result = await db.execute(
        select(User.username).where(User.username.ilike(f"{base}%", escape="\\"))
    )
    taken = {u.lower() for u in result.scalars().all()}
    if base not in taken:
        return base
    suffix = 2
    while f"{base}-{suffix}" in taken:
        suffix += 1
    return f"{base}-{suffix}"

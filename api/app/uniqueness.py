import uuid

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession


async def name_taken(
    db: AsyncSession,
    id_col,
    name_col,
    name: str,
    *,
    exclude_id: uuid.UUID | None = None,
) -> bool:
    """Case-insensitive uniqueness check. Pass the model's id + name columns
    (e.g. `Role.id, Role.name` or `User.id, User.username`)."""
    stmt = select(id_col).where(func.lower(name_col) == name.lower())
    if exclude_id is not None:
        stmt = stmt.where(id_col != exclude_id)
    return (await db.execute(stmt.limit(1))).first() is not None

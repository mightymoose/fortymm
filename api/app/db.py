import os
from collections.abc import AsyncIterator

from sqlalchemy.ext.asyncio import (
    AsyncAttrs,
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase

DEFAULT_DATABASE_URL = "postgresql+asyncpg://postgres:postgres@localhost:5432/fortymm"


def get_database_url() -> str:
    return os.environ.get("DATABASE_URL", DEFAULT_DATABASE_URL)


class Base(AsyncAttrs, DeclarativeBase):
    """The declarative base every model hangs off.

    ``AsyncAttrs`` adds one thing: ``await obj.awaitable_attrs.<relationship>``, the
    sanctioned way to load a **lazy** relationship on an already-loaded object under
    async. Without it the only spellings are a plain attribute access — which emits IO
    from a sync context and raises ``MissingGreenlet`` rather than querying — or a
    throwaway ``select()`` issued purely so its loader option populates the identity
    map, which costs a second round trip to re-read a row already in the session.

    It adds no columns, no behaviour and no cost to a model that never uses it.
    """


_engine: AsyncEngine | None = None
_sessionmaker: async_sessionmaker[AsyncSession] | None = None


def get_engine() -> AsyncEngine:
    global _engine, _sessionmaker
    if _engine is None:
        _engine = create_async_engine(get_database_url(), pool_pre_ping=True)
        _sessionmaker = async_sessionmaker(_engine, expire_on_commit=False)
    return _engine


def get_sessionmaker() -> async_sessionmaker[AsyncSession]:
    """The process-wide async session factory, engine lazily initialised.

    ``get_session`` is the request-scoped FastAPI dependency; this is the raw
    factory for callers that own the session lifecycle themselves — an MCP tool
    or verifier, a script, a REPL — outside any FastAPI request (see
    ``api/CLAUDE.md``: "outside a request you own the session lifecycle
    yourself").
    """
    if _sessionmaker is None:
        get_engine()
    assert _sessionmaker is not None
    return _sessionmaker


async def get_session() -> AsyncIterator[AsyncSession]:
    async with get_sessionmaker()() as session:
        yield session

"""The API's Postgres connections, from the pool `create_app()` opens."""

from collections.abc import Iterator
from typing import Annotated

from fastapi import Depends, Request
from psycopg import Connection
from psycopg_pool import ConnectionPool


def get_connection(request: Request) -> Iterator[Connection]:
    """Lend a route a connection from the pool for the request."""
    pool: ConnectionPool | None = getattr(request.app.state, "pool", None)
    if pool is None:
        raise RuntimeError("DATABASE_URL isn't set, so the API has no database")
    with pool.connection() as connection:
        yield connection


DatabaseConnection = Annotated[Connection, Depends(get_connection)]

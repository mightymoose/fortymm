"""The API's Postgres engine, and the ORM session each request runs in."""

from collections.abc import Iterator
from typing import Annotated

from fastapi import Depends, Request
from sqlalchemy import Engine, create_engine, make_url
from sqlalchemy.orm import Session, sessionmaker


def create_database_engine(database_url: str) -> Engine:
    """Make an engine for `DATABASE_URL`, through the psycopg 3 driver."""
    url = make_url(database_url).set(drivername="postgresql+psycopg")
    # At most 4 connections: db-f1-micro allows 25, shared by up to 3
    # production instances and the Preview revisions.
    return create_engine(url, pool_size=1, max_overflow=3)


def get_session(request: Request) -> Iterator[Session]:
    """Run the request in one transaction: commit if it succeeds, else roll back."""
    sessions: sessionmaker[Session] | None = request.app.state.sessions
    if sessions is None:
        raise RuntimeError("DATABASE_URL isn't set, so the API has no database")
    with sessions.begin() as session:
        yield session


# scope="function" commits before FastAPI sends the response, so a failed
# commit answers 500. The default for a yield dependency commits after the
# client already has a 200.
DatabaseSession = Annotated[Session, Depends(get_session, scope="function")]

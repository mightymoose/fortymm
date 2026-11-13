from urllib.parse import parse_qs

from pydantic import PostgresDsn, UrlConstraints, field_validator
from pydantic_settings import BaseSettings


class DatabaseUrl(PostgresDsn):
    """A PostgresDsn whose host may instead be a Unix socket's directory, in the `host` query
    parameter: postgresql:///database?host=/cloudsql/<instance>&user=<user>. That is how a
    Cloud Run service reaches its Cloud SQL instance. The user goes in a query parameter too:
    a URL can't have a user without a host."""

    _constraints = UrlConstraints(
        host_required=False, allowed_schemes=PostgresDsn._constraints.allowed_schemes
    )


class Settings(BaseSettings):
    """Configuration, read from the environment when the app starts."""

    # DATABASE_URL, e.g. postgresql://user:password@host:5432/database, or
    # postgresql:///database?host=/cloudsql/<instance>&user=<user> for a Unix socket. The
    # password may come from PGPASSWORD instead of the URL (asyncpg reads it).
    database_url: DatabaseUrl

    @field_validator("database_url")
    @classmethod
    def _names_a_host(cls, url: DatabaseUrl) -> DatabaseUrl:
        if any(host["host"] for host in url.hosts()):
            return url
        if parse_qs(url.query or "").get("host"):
            return url
        raise ValueError("DATABASE_URL names no host: give one, or a socket directory in ?host=")

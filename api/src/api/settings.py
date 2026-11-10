from pydantic import PostgresDsn
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Configuration, read from the environment when the app starts."""

    # DATABASE_URL, e.g. postgresql://user:password@host:5432/database
    database_url: PostgresDsn

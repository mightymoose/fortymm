from typing import Literal

import fortymm_core
from pydantic import PostgresDsn
from pydantic_settings import BaseSettings

ENVIRONMENT_NUMBERS = {
    "production": fortymm_core.PRODUCTION,
    "uat": fortymm_core.UAT,
    "development": fortymm_core.DEVELOPMENT,
}


class Settings(BaseSettings):
    """Configuration, read from the environment when the app starts."""

    # DATABASE_URL, e.g. postgresql://user:password@host:5432/database
    database_url: PostgresDsn
    # ENVIRONMENT: the deployment this server is. Records and parcels carry an
    # environment number (core/FORMAT.md section 4), and the server takes only
    # its own.
    environment: Literal["production", "uat", "development"]

    @property
    def environment_number(self) -> int:
        return ENVIRONMENT_NUMBERS[self.environment]

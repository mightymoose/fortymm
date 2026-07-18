"""Shared application configuration.

New configuration belongs here as a field on ``Settings`` rather than another
ad hoc ``os.environ.get(...)`` call site scattered through the codebase (see
"Module layout for new code" in ``api/CLAUDE.md``). Existing ad hoc readers
(``app/db.py``, ``app/captcha.py``, ``app/queue.py``) predate this module and
are left as-is.
"""

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore")

    #: The CP-SAT wall-clock time cap, in seconds, for a schedule solve
    #: (``app.scheduling.solve``'s ``time_cap_s``). The ADR's default is a
    #: hard cap: mid-tournament we want a good answer now, not a proof, and
    #: FEASIBLE under the cap is accepted. Large one-off solves (e.g. a big
    #: multi-day tournament with hundreds of fixtures) may need this raised
    #: well past the default — there is deliberately no upper clamp.
    solver_time_cap_s: float = 10.0


def get_settings() -> Settings:
    """Read settings from the environment.

    Constructed fresh on every call rather than cached at import time, so
    tests can override an environment variable (``monkeypatch.setenv(...)``)
    per test and see it take effect — mirrors ``app.db.get_database_url()``.
    """
    return Settings()

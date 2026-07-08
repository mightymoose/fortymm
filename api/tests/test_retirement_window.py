from datetime import timedelta

import pytest
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import MatchSettings


async def test_retirement_window_defaults_to_seven_days(db_session: AsyncSession):
    settings = MatchSettings(team_size=1, best_of=5)
    db_session.add(settings)
    await db_session.commit()
    await db_session.refresh(settings)

    assert settings.retirement_window == timedelta(days=7)


async def test_retirement_window_allows_null(db_session: AsyncSession):
    settings = MatchSettings(team_size=1, best_of=5)
    db_session.add(settings)
    await db_session.commit()

    # Explicitly clearing the window to NULL is permitted by the constraint.
    settings.retirement_window = None
    await db_session.commit()
    await db_session.refresh(settings)

    assert settings.retirement_window is None


async def test_retirement_window_rejects_zero(db_session: AsyncSession):
    settings = MatchSettings(team_size=1, best_of=5, retirement_window=timedelta(0))
    db_session.add(settings)
    with pytest.raises(IntegrityError):
        await db_session.commit()

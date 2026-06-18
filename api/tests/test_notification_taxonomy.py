"""The shared display taxonomy endpoint: the ordered category/channel lists with
their labels, read from the lookup tables."""

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.notifications.taxonomy import NotificationCategory, NotificationChannel
from tests._helpers import start_session


async def test_taxonomy_lists_types_in_display_order(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    data = (await api_client.get("/v1/notification-taxonomy")).json()

    keys = [t["key"] for t in data["types"]]
    assert keys == [c.value for c in NotificationCategory]

    match = next(t for t in data["types"] if t["key"] == "match_reminder")
    assert match["label"] == "Match reminders"
    assert match["short"] == "Match"


async def test_taxonomy_lists_channels_with_availability(
    api_client: AsyncClient, db_session: AsyncSession
):
    await start_session(api_client, db_session)
    data = (await api_client.get("/v1/notification-taxonomy")).json()

    keys = [c["key"] for c in data["channels"]]
    assert keys == [c.value for c in NotificationChannel]

    by_key = {c["key"]: c for c in data["channels"]}
    assert by_key["in_app"]["label"] == "In-app"
    assert by_key["in_app"]["available"] is True
    assert by_key["sms"]["available"] is False

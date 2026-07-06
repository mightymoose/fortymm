from app.notifications.apns import APNsClient, APNsConfig, SendOutcome


async def test_send_returns_failed_on_malformed_auth_key() -> None:
    """A malformed/expired ``APNS_AUTH_KEY`` must not raise out of ``send`` —
    that would abort the whole ``notify()`` call (including the email
    enqueue) for every subsequent push in the fan-out (#753)."""
    client = APNsClient(
        APNsConfig(
            key_id="key-id",
            team_id="team-id",
            bundle_id="com.fortymm.ios-client",
            auth_key_pem="not a real PEM key",
        )
    )

    result = await client.send(
        "device-token",
        environment="sandbox",
        title="title",
        body="body",
    )

    assert result.outcome is SendOutcome.FAILED

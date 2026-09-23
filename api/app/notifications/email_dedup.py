"""Non-PII evidence for suppressing duplicate notification email delivery."""

import hashlib
import hmac
import os

from app.config import get_settings

_DEV_SECRET = "fortymm-development-notification-email-dedup"


def email_delivery_key(address: str | None) -> str | None:
    """Return stable comparison evidence without putting an address in Redis."""
    if address is None:
        return None
    secret = get_settings().notification_email_dedup_secret.strip()
    if not secret:
        if os.environ.get("FORTYMM_DEV", "").lower() not in {"1", "true", "yes"}:
            # Never fall back to a dictionary-recoverable bare address hash in
            # a deployed process. Without a key, omit the optimization rather
            # than leaking reusable evidence into Redis.
            return None
        secret = _DEV_SECRET
    normalized = address.strip().casefold().encode("utf-8")
    digest = hmac.new(secret.encode("utf-8"), normalized, hashlib.sha256).hexdigest()
    return f"v1:{digest}"
